import 'dotenv/config'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { EmptyRelations } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import { drizzle } from 'drizzle-orm/libsql'
import { Octokit } from 'octokit'
import { simpleGit } from 'simple-git'
import type { SimpleGit } from 'simple-git'

import { repos, cves, samples } from './db/schema.ts'
import { clone } from './lib/cloner.ts'
import {
  CUTOFF,
  DURATION_365D,
  DURATION_90D,
  SAMPLE_DURATION
} from './lib/constants.ts'
import { parseGithubRepoUrl } from './lib/github.ts'
import type { GitCommit, TimePeriod } from './lib/types.ts'

type Advisory = Awaited<
  ReturnType<Octokit['rest']['securityAdvisories']['listGlobalAdvisories']>
>['data'][number]
type GitHubAdvisory = Omit<Advisory, 'source_code_location' | 'cve_id'> & {
  source_code_location: `https://github.com/${string}`
  cve_id: string
}

export async function scrapeData(): Promise<void> {
  const processedRepos: string[] = []
  const db = drizzle(process.env.DB_FILE_NAME!)
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
  })

  for await (const response of await octokit.paginate.iterator(
    octokit.rest.securityAdvisories.listGlobalAdvisories,
    {
      per_page: 100,
      published: `<=${CUTOFF}`
    }
  )) {
    await Promise.all(
      response.data
        .filter(
          (advisory): advisory is GitHubAdvisory =>
            !!advisory.source_code_location?.startsWith(
              'https://github.com/'
            ) && typeof advisory.cve_id === 'string'
        )
        .map(async ({ source_code_location, cve_id, published_at }) => {
          const random = Math.random()
          const logCve = async (bucket: 'training' | 'validation' | 'test') => {
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
          if (!processedRepos.includes(source_code_location)) {
            processedRepos.push(source_code_location)
            await processGitRepo(db, octokit, source_code_location)
          }
        })
    )
  }
}

/**
 * Process a Git repository by fetching its commits and associated CVEs.
 * @param db The database instance to use for storing the data.
 * @param octokit The Octokit instance to use for GitHub API calls.
 * @param repoUrl The URL of the Git repository to process.
 */
async function processGitRepo(
  db: LibSQLDatabase<EmptyRelations>,
  octokit: Octokit,
  repoUrl: string
) {
  await using directory = await fs.mkdtempDisposable(
    path.join(os.tmpdir(), 'predictive-cve-repo')
  )
  const git = simpleGit(directory.path, {
    maxConcurrentProcesses: os.availableParallelism()
  })

  const [repoCves, commits] = await Promise.all([
    findRepoCves(octokit, repoUrl),
    readCommits(git, repoUrl, directory.path)
  ])
  console.log(`Retrieved ${commits.length} commits for ${repoUrl}`)
  const sampleRows = await buildSampleRows(git, repoUrl, commits, repoCves)

  console.log(`Sample rows for ${repoUrl}: ${JSON.stringify(sampleRows)}`)

  if (sampleRows.length > 0) {
    await db.insert(samples).values(sampleRows).onConflictDoNothing()
  }
}

type SampleRow = typeof samples.$inferInsert

async function findRepoCves(
  octokit: Octokit,
  repoUrl: string
): Promise<Array<{ publishedAt: Temporal.Instant }>> {
  const { owner, repo } = parseGithubRepoUrl(repoUrl)
  const advisories = await octokit.paginate(
    octokit.rest.securityAdvisories.listRepositoryAdvisories,
    { owner, repo, per_page: 100 }
  )

  return advisories
    .filter(
      (
        advisory
      ): advisory is typeof advisory & {
        cve_id: string
        published_at: string
      } =>
        typeof advisory.cve_id === 'string' &&
        typeof advisory.published_at === 'string'
    )
    .map(({ published_at }) => ({
      publishedAt: Temporal.Instant.from(published_at)
    }))
}

/**
 * Get the commits for a given Git repository, ordered from oldest to newest.
 * @param git The SimpleGit instance to use for the Git operations.
 * @param repoUrl The URL of the Git repository.
 * @param directory The directory to clone the repository into.
 * @returns A promise that resolves to an array of Git commits.
 */
async function readCommits(
  git: SimpleGit,
  repoUrl: string,
  directory: string
): Promise<GitCommit[]> {
  console.log(`Cloning ${repoUrl} into ${directory}`)
  await clone(repoUrl, directory, ['--filter=blob:none'])
  console.log(`Cloned ${repoUrl} into ${directory}`)

  const output = await git.log({
    format: {
      hash: '%H',
      date: '%aI',
      author: '%an',
      email: '%ae'
    }
  })

  return Promise.all(
    output.all
      .filter(
        ({ date }) =>
          Temporal.Instant.compare(Temporal.Instant.from(date), CUTOFF) === -1
      )
      .reverse()
      .map(async ({ hash, date, email }) => {
        const { insertions, deletions, files } = await git.diffSummary([
          `${hash}^!`
        ])
        return {
          hash,
          date: Temporal.Instant.from(date),
          email,
          insertions,
          deletions,
          files: files.length
        }
      })
  )
}

/**
 * Build a list of sample rows for a given Git repository.
 * @param git The SimpleGit instance to use for the Git operations.
 * @param repoUrl The URL of the Git repository.
 * @param commits A list of commits, ordered from oldest to newest.
 * @param repoCves A list of CVEs associated with the repository.
 * @returns A promise that resolves to an array of sample rows.
 */
async function buildSampleRows(
  git: SimpleGit,
  repoUrl: string,
  commits: GitCommit[],
  repoCves: Array<{ publishedAt: Temporal.Instant }>
): Promise<SampleRow[]> {
  if (commits.length === 0) throw Error(`No commits found for ${repoUrl}`)
  const durationMs = SAMPLE_DURATION.total({ unit: 'milliseconds' })
  const firstDate = commits[0].date
  const lastDate = commits.at(-1)!.date
  const sampleCount = Math.floor(
    lastDate.since(firstDate).total({ unit: 'milliseconds' }) / durationMs
  )
  console.log(`Building ${sampleCount} sample rows for ${repoUrl}`)
  const tagDates = await readTagDates(git)

  return Promise.all(
    Array.from({ length: sampleCount }, (_, index) => {
      const start = firstDate.add({ milliseconds: index * durationMs })
      const end = start.add({ milliseconds: durationMs })
      console.log(`Building sample row for ${repoUrl} from ${start} to ${end}`)
      return buildSampleRow(
        git,
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
}

async function buildSampleRow(
  git: SimpleGit,
  repoUrl: string,
  commits: GitCommit[],
  repoCves: Array<{ publishedAt: Temporal.Instant }>,
  period: TimePeriod,
  tagDates: Temporal.Instant[]
): Promise<SampleRow> {
  const allCommits = commits.filter(
    (commit) => Temporal.Instant.compare(commit.date, period.end) < 0
  )
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
      isInPeriod(publishedAt, period.end, DURATION_365D)
    ).length,
    ...contributorMetrics(
      commits90d,
      allCommits,
      period.end,
      DURATION_90D,
      '90d'
    ),
    ...contributorMetrics(
      commits365d,
      allCommits,
      period.end,
      DURATION_365D,
      '365d'
    ),
    ...contributorMetrics(allCommits, allCommits, period.end, undefined, 'all'),
    commits_90d: commits90d.length,
    commits_365d: commits365d.length,
    commits_all: allCommits.length,
    repo_age_days: Math.floor(
      period.end.since(commits[0].date).total({ unit: 'days' })
    ),
    ...(await treeMetrics(git, allCommits.at(-1)?.hash)),
    cov_inter_commit_90d: normalizedCovBetweenInstants(
      commits90d.map((c) => c.date)
    ),
    cov_inter_commit_365d: normalizedCovBetweenInstants(
      commits365d.map((c) => c.date)
    ),
    cov_inter_commit_all: normalizedCovBetweenInstants(
      allCommits.map((c) => c.date)
    ),
    cov_inter_tag_90d: normalizedCovBetweenInstants(
      tagDates.filter((date) => isInPeriod(date, period.end, DURATION_90D))
    ),
    cov_inter_tag_365d: normalizedCovBetweenInstants(
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

function isInPeriod(
  date: Temporal.Instant,
  end: Temporal.Instant,
  duration: Temporal.Duration
): boolean {
  const start = end.subtract(duration)
  return (
    Temporal.Instant.compare(date, start) > 0 &&
    Temporal.Instant.compare(date, end) <= 0
  )
}

function contributorMetrics<T extends '90d' | '365d' | 'all'>(
  commits: GitCommit[],
  allCommits: GitCommit[],
  end: Temporal.Instant,
  duration: Temporal.Duration | undefined,
  suffix: T
): {
  [
    K in
      | `contributors_${T}`
      | `bus_factor_${T}`
      | `top_contributor_share_${T}`
      | `new_contributor_rate_${T}`
  ]: number
} {
  const authors: Array<{
    emails: string[]
    commits: number
  }> = []
  for (const commit of commits) {
    const existing = [
      ...authors.filter((c) => c.emails.includes(commit.email)).entries()
    ]
    if (existing.length > 0) {
      const [first, ...rest] = existing
      first[1].commits += rest.reduce((total, [, c]) => total + c.commits, 0)
      first[1].emails.push(...rest.flatMap(([, c]) => c.emails))
      for (const [index] of rest) {
        authors.splice(index, 1)
      }
    } else {
      authors.push({
        emails: [commit.email],
        commits: 1
      })
    }
  }
  console.log(`${authors.length} authors for ${suffix}`)

  const ordered = authors.map((c) => c.commits).sort((a, b) => b - a)
  const total = commits.length
  let accumulated = 0
  let busFactor = 0
  while (accumulated < total / 2 && busFactor < ordered.length) {
    accumulated += ordered[busFactor++]
  }

  const firstCommitByAuthor = new Map<number, Temporal.Instant>()
  for (const commit of allCommits) {
    const authorIndex = authors.findIndex((a) =>
      a.emails.includes(commit.email)
    )
    console.log(`Author index: ${authorIndex}`)
    if (!firstCommitByAuthor.has(authorIndex)) {
      firstCommitByAuthor.set(authorIndex, commit.date)
    }
  }

  const newContributors = [...firstCommitByAuthor.values()].filter(
    (date) =>
      Temporal.Instant.compare(date, end) <= 0 &&
      (duration === undefined || isInPeriod(date, end, duration))
  ).length
  const result = Object.create(null)
  result[`contributors_${suffix}`] = authors.length
  result[`bus_factor_${suffix}`] = busFactor
  result[`top_contributor_share_${suffix}`] = normalizedDivide(
    ordered[0] ?? 0,
    total
  )
  result[`new_contributor_rate_${suffix}`] = normalizedDivide(
    newContributors,
    authors.length
  )
  return result
}

function normalizedDivide(numerator: number, denominator: number) {
  return denominator !== 0 ? numerator / denominator : 0
}

function churn(commits: GitCommit[]) {
  return commits.reduce(
    (total, commit) => total + commit.insertions + commit.deletions,
    0
  )
}

function normalizedCovBetweenInstants(instants: Temporal.Instant[]) {
  if (instants.length < 2) return 0
  const durationsMillis = instants
    .slice(1)
    .map((instant, i) => instant.since(instants[i]).abs().milliseconds)
  const mean =
    durationsMillis.reduce((total, d) => total + d, 0) / durationsMillis.length
  const variance =
    durationsMillis.reduce((total, d) => total + Math.pow(d - mean, 2), 0) /
    durationsMillis.length
  return Math.sqrt(variance) / mean
}

async function readTagDates(git: SimpleGit) {
  const tags = await git.tags()
  const dates = await Promise.all(
    tags.all.map(async (tag) => {
      const log = await git.log(['-1', tag])
      return Temporal.Instant.from(log.latest?.date ?? '')
    })
  )
  return dates
}

async function treeMetrics(git: SimpleGit, hash: string | undefined) {
  if (!hash) return { loc: 0, file_count: 0 }
  const files = (await git.raw(['ls-tree', '-r', '--name-only', hash]))
    .split('\n')
    .filter(Boolean)
  const contents = await Promise.all(
    files.map(async (file) => {
      try {
        return await git.show([`${hash}:${file}`])
      } catch {
        return ''
      }
    })
  )
  return {
    loc: contents.reduce(
      (total, content) => total + content.split('\n').length,
      0
    ),
    file_count: files.length
  }
}
