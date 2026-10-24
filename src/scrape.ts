import 'dotenv/config'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { throttling } from '@octokit/plugin-throttling'
import { eq } from 'drizzle-orm'
import type { EmptyRelations } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import { Octokit } from 'octokit'
import pLimit from 'p-limit'
import { simpleGit } from 'simple-git'
import type { SimpleGit } from 'simple-git'

import { repos, cves, samples } from './db/schema.ts'
import { readAuthors } from './lib/helpers/authors.ts'
import {
  CUTOFF,
  DURATION_365D,
  DURATION_90D,
  SAMPLE_DURATION,
  REPO_DIR,
  MAX_CONCURRENT_REPOS,
  BLOCKLIST
} from './lib/helpers/constants.ts'
import { initDrizzle } from './lib/helpers/drizzle.ts'
import {
  covBetweenInstants,
  isInPeriod,
  normalizedCovBetweenInstants
} from './lib/helpers/math.ts'
import { readTagDates } from './lib/helpers/repo.ts'
import { readCommits } from './lib/metrics/repo/commits.ts'
import { findRepoCves } from './lib/metrics/repo/cve.ts'
import { contributorMetrics } from './lib/metrics/sample/contributor.ts'
import { scorecardMetrics } from './lib/metrics/sample/scorecard.ts'
import { treeMetrics } from './lib/metrics/sample/tree.ts'
import type { GitCommit, SampleRow, TimePeriod } from './lib/types.ts'

type Advisory = Awaited<
  ReturnType<Octokit['rest']['securityAdvisories']['listGlobalAdvisories']>
>['data'][number]
type GitHubAdvisory = Omit<Advisory, 'source_code_location' | 'cve_id'> & {
  source_code_location: `https://github.com/${string}`
  cve_id: string
}

/**
 * Scrape GitHub security advisories and repository history into the database.
 *
 * @remarks Advisory pagination is restricted to publications at or before
 * `CUTOFF`. Repository processing assumes each source URL identifies a
 * clonable GitHub repository and that the database and GitHub credentials are
 * configured in the environment.
 */
export async function scrapeData(): Promise<void> {
  const processedRepos = new Set<string>()
  await fs.rm(REPO_DIR, { recursive: true, force: true })
  await fs.mkdir(REPO_DIR, { recursive: true })
  const db = await initDrizzle()
  if (!process.env.GITHUB_TOKEN) console.error('GITHUB_TOKEN is not set')
  const octokitClass = Octokit.plugin(throttling)
  const octokit = new octokitClass({
    auth: process.env.GITHUB_TOKEN,
    throttle: {
      onRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(
          `Request quota exhausted for request ${options.method} ${options.url}`
        )
        return true
      },
      onSecondaryRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(
          `SecondaryRateLimit detected for request ${options.method} ${options.url}`
        )
        return true
      }
    }
  })

  for await (const response of octokit.paginate.iterator(
    octokit.rest.securityAdvisories.listGlobalAdvisories,
    {
      per_page: 100,
      published: `<=${CUTOFF.toString()}`
    }
  )) {
    await Promise.all(
      response.data
        .filter(
          (advisory): advisory is GitHubAdvisory =>
            !!advisory.source_code_location?.startsWith(
              'https://github.com/'
            ) &&
            typeof advisory.cve_id === 'string' &&
            !BLOCKLIST.includes(advisory.source_code_location)
        )
        .map(async ({ source_code_location, cve_id, published_at }) => {
          if (!processedRepos.has(source_code_location)) {
            processedRepos.add(source_code_location)
            const existingSamples = await db
              .select({ id: samples.id })
              .from(samples)
              .where(eq(samples.repo_url, source_code_location))
              .limit(1)
            if (existingSamples.length > 0) {
              console.log(
                `Skipping ${source_code_location}; samples already collected`
              )
              return
            }
            const random = Math.random()
            const logCve = async (
              bucket: 'training' | 'validation' | 'test'
            ) => {
              await db
                .insert(repos)
                .values({ bucket, url: source_code_location })
                .onConflictDoNothing()
              await db
                .insert(cves)
                .values({
                  cve_id,
                  published_at: new Date(published_at),
                  repo_url: source_code_location
                })
                .onConflictDoNothing()
            }
            if (random > 0.8) {
              await logCve('test')
            } else if (random > 0.7) {
              await logCve('validation')
            } else {
              await logCve('training')
            }
            return processGitRepo(db, octokit, source_code_location)
          }
        })
    )
  }
}

const limit = pLimit(MAX_CONCURRENT_REPOS)
const processGitRepo = (...args: Parameters<typeof processGitRepoInternal>) =>
  limit(() => processGitRepoInternal(...args))

/**
 * Process a Git repository by fetching its commits and associated CVEs.
 * @param db The database instance to use for storing the data.
 * @param octokit The Octokit instance to use for GitHub API calls.
 * @param repoUrl The URL of the Git repository to process.
 * @remarks The repository is assumed to be available through both GitHub's
 * API and Git clone. The commit history returned by `readCommits` is ordered
 * oldest-to-newest and ends strictly before `CUTOFF`; downstream sampling
 * depends on those assumptions.
 */
async function processGitRepoInternal(
  db: LibSQLDatabase<EmptyRelations>,
  octokit: Octokit,
  repoUrl: string
) {
  await using directory = await fs.mkdtempDisposable(
    path.join(REPO_DIR, 'predictive-cve-repo')
  )
  const git = simpleGit(directory.path, {
    maxConcurrentProcesses: os.availableParallelism()
  })

  const [repoCves, commits] = await Promise.all([
    findRepoCves(octokit, repoUrl),
    readCommits(git, repoUrl, directory.path)
  ])
  console.log(`Retrieved ${commits.length} commits for ${repoUrl}`)
  if (commits.length === 0) throw Error(`No commits found for ${repoUrl}`)
  const durationMs = SAMPLE_DURATION.total('milliseconds')
  const firstDate = commits[0].date
  const lastDate = commits.at(-1)!.date
  const sampleCount = Math.floor(
    lastDate.since(firstDate).total('milliseconds') / durationMs
  )
  console.log(`Building ${sampleCount} sample rows for ${repoUrl}`)
  const tagDates = await readTagDates(git)

  const sampleRows = await Promise.all(
    Array.from({ length: sampleCount }, (_, index) => {
      const start = firstDate.add({ milliseconds: index * durationMs })
      const end = start.add({ milliseconds: durationMs })
      console.log(
        `Building sample row for ${repoUrl} from ${start.toString()} to ${end.toString()}`
      )
      return buildSampleRow(
        git,
        directory.path,
        repoUrl,
        commits,
        repoCves,
        {
          start,
          end
        },
        tagDates
      )
    })
  )

  console.log(`${sampleRows.length} sample rows for ${repoUrl}`)

  if (sampleRows.length > 0) {
    await db.insert(samples).values(sampleRows).onConflictDoNothing()
  }
}

/**
 * Build metrics for one sampling period.
 *
 * @param git The SimpleGit instance used to inspect the repository tree.
 * @param directory The directory containing the cloned repository.
 * @param repoUrl The repository URL to store in the sample row.
 * @param commits Commits ordered oldest-to-newest and ending strictly before
 * `CUTOFF`.
 * @param repoCves CVE publication timestamps; ordering is not required.
 * @param period The sample interval, with an exclusive start and inclusive
 * end for commit and CVE selection.
 * @param tagDates Commit timestamps associated with tags; ordering is not
 * required.
 * @returns The metrics for the requested period.
 * @remarks The commit list is assumed to contain the complete history needed
 * for the period and to be non-empty. Its first commit supplies repository
 * age, while its last commit before the period end supplies tree metrics.
 */
async function buildSampleRow(
  git: SimpleGit,
  directory: string,
  repoUrl: string,
  commits: GitCommit[],
  repoCves: Array<{ publishedAt: Temporal.Instant }>,
  period: TimePeriod,
  tagDates: Temporal.Instant[]
): Promise<SampleRow> {
  const allCommits = commits.filter(
    (commit) => Temporal.Instant.compare(commit.date, period.end) <= 0
  )
  // Authors are inferred per sample rather than globally
  // as deduplication logic is only ran historically at sample time;
  // future merges are not evident from the present
  const authors = await readAuthors(allCommits)
  console.log(`Authors for repo ${repoUrl}: ${authors.length}`)
  const commits90d = commits.filter(({ date }) =>
    isInPeriod(date, period.end, DURATION_90D)
  )
  console.log(
    `Filtered commits for repo ${repoUrl} for 90 days: ${commits90d.length}`
  )
  const commits365d = commits.filter(({ date }) =>
    isInPeriod(date, period.end, DURATION_365D)
  )
  console.log(
    `Filtered commits for repo ${repoUrl} for 365 days: ${commits365d.length}`
  )
  return {
    date_unix: new Date(period.end.epochMilliseconds),
    repo_url: repoUrl,
    cves_reported_365d: repoCves.filter(({ publishedAt }) =>
      isInPeriod(publishedAt, period.end.add(DURATION_365D), DURATION_365D)
    ).length,
    ...contributorMetrics(
      commits90d,
      allCommits,
      authors,
      period.end,
      DURATION_90D,
      '90d'
    ),
    ...contributorMetrics(
      commits365d,
      allCommits,
      authors,
      period.end,
      DURATION_365D,
      '365d'
    ),
    ...contributorMetrics(
      allCommits,
      allCommits,
      authors,
      period.end,
      undefined,
      'all'
    ),
    commits_90d: commits90d.length,
    commits_365d: commits365d.length,
    commits_all: allCommits.length,
    repo_age_days: Math.floor(period.end.since(commits[0].date).total('days')),
    ...(await treeMetrics(git, allCommits.at(-1)?.hash)),
    ...(await scorecardMetrics(directory, allCommits.at(-1)?.hash, repoUrl)),
    cov_inter_commit_90d: covBetweenInstants(commits90d.map((c) => c.date)),
    cov_inter_commit_365d: covBetweenInstants(commits365d.map((c) => c.date)),
    cov_inter_commit_all: normalizedCovBetweenInstants(
      allCommits.map((c) => c.date)
    ),
    cov_inter_tag_90d: covBetweenInstants(
      tagDates.filter((date) => isInPeriod(date, period.end, DURATION_90D))
    ),
    cov_inter_tag_365d: covBetweenInstants(
      tagDates.filter((date) => isInPeriod(date, period.end, DURATION_365D))
    ),
    cov_inter_tag_all: normalizedCovBetweenInstants(
      tagDates.filter((date) => Temporal.Instant.compare(date, period.end) <= 0)
    ),
    churn_90d: churn(commits90d),
    churn_365d: churn(commits365d),
    churn_all: churn(allCommits)
  }
}

/**
 * Sum insertions and deletions across commits.
 *
 * @param commits Commits whose insertion and deletion counts are summed.
 * @returns Total line churn.
 */
function churn(commits: GitCommit[]) {
  return commits.reduce(
    (total, commit) => total + commit.insertions + commit.deletions,
    0
  )
}
