import 'dotenv/config'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { EmptyRelations } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
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
import { initDrizzle } from './lib/drizzle.ts'
import { parseGithubRepoUrl } from './lib/github.ts'
import type { GitCommit, TimePeriod } from './lib/types.ts'

type Advisory = Awaited<
  ReturnType<Octokit['rest']['securityAdvisories']['listGlobalAdvisories']>
>['data'][number]
type GitHubAdvisory = Omit<Advisory, 'source_code_location' | 'cve_id'> & {
  source_code_location: `https://github.com/${string}`
  cve_id: string
}

const execFileAsync = promisify(execFile)

/**
 * Scrape GitHub security advisories and repository history into the database.
 *
 * @remarks Advisory pagination is restricted to publications at or before
 * `CUTOFF`. Repository processing assumes each source URL identifies a
 * clonable GitHub repository and that the database and GitHub credentials are
 * configured in the environment.
 */
export async function scrapeData(): Promise<void> {
  const processedRepos: string[] = []
  const db = await initDrizzle()
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
 * @remarks The repository is assumed to be available through both GitHub's
 * API and Git clone. The commit history returned by `readCommits` is ordered
 * oldest-to-newest and ends strictly before `CUTOFF`; downstream sampling
 * depends on those assumptions.
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
  const sampleRows = await buildSampleRows(
    git,
    directory.path,
    repoUrl,
    commits,
    repoCves
  )

  console.log(`Sample rows for ${repoUrl}: ${JSON.stringify(sampleRows)}`)

  if (sampleRows.length > 0) {
    await db.insert(samples).values(sampleRows).onConflictDoNothing()
  }
}

type SampleRow = typeof samples.$inferInsert

/**
 * Find publication timestamps for CVEs associated with a repository.
 *
 * @param octokit The Octokit instance to use for GitHub API calls.
 * @param repoUrl A GitHub repository URL that can be parsed into an owner and
 * repository name.
 * @returns CVE publication timestamps for advisories with both a CVE ID and a
 * publication date.
 * @remarks The returned timestamps are not sorted and are not filtered by
 * `CUTOFF`; callers are responsible for applying time-window boundaries.
 */
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
 * Get the commits for a given Git repository, ordered from oldest to newest
 * and stopping at the cutoff date.
 * @param git The SimpleGit instance to use for the Git operations.
 * @param repoUrl The URL of the Git repository.
 * @param directory The directory to clone the repository into.
 * @returns A promise that resolves to an array of Git commits.
 * @remarks The clone is assumed to contain the complete history. Only commits
 * strictly earlier than `CUTOFF` are returned, so a commit exactly at the
 * cutoff is excluded. Each returned commit is also assumed to have a usable
 * parent for `git.diffSummary`.
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
 * @param directory The directory containing the cloned repository.
 * @param repoUrl The URL of the Git repository.
 * @param commits A non-empty list of commits, ordered from oldest to newest
 * and ending strictly before `CUTOFF`.
 * @param repoCves A list of CVE publication timestamps associated with the
 * repository; ordering is not required.
 * @returns A promise that resolves to an array of sample rows.
 * @remarks The first and last commit dates define the sampling range. Only
 * complete `SAMPLE_DURATION` windows are emitted; a remaining partial window
 * is discarded.
 */
async function buildSampleRows(
  git: SimpleGit,
  directory: string,
  repoUrl: string,
  commits: GitCommit[],
  repoCves: Array<{ publishedAt: Temporal.Instant }>
): Promise<SampleRow[]> {
  if (commits.length === 0) throw Error(`No commits found for ${repoUrl}`)
  const durationMs = SAMPLE_DURATION.total('milliseconds')
  const firstDate = commits[0].date
  const lastDate = commits.at(-1)!.date
  const sampleCount = Math.floor(
    lastDate.since(firstDate).total('milliseconds') / durationMs
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
        directory,
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

type ScorecardCheck = {
  name: string
  score: number
}

type ScorecardResult = {
  checks: ScorecardCheck[]
}

/**
 * Run OpenSSF Scorecard against the commit selected for a sample period.
 *
 * @param directory The directory containing the cloned repository.
 * @param hash The commit selected for the sample period, or `undefined` when
 * no commit exists before the period end.
 * @param repoUrl The repository URL, used to identify failures in logs.
 * @returns The Scorecard check scores mapped to sample columns.
 * @remarks Scorecard is expected to be available as `scorecard` on `PATH`, or
 * at the path supplied by `SCORECARD_BINARY`. Checks that are not returned by
 * Scorecard are stored as `null`.
 */
async function scorecardMetrics(
  directory: string,
  hash: string | undefined,
  repoUrl: string
): Promise<
  Pick<
    SampleRow,
    | 'scorecard_binary_artifacts'
    | 'scorecard_dangerous_workflow'
    | 'scorecard_dependency_update_tool'
    | 'scorecard_license'
    | 'scorecard_pinned_dependencies'
    | 'scorecard_permissions'
    | 'scorecard_security_policy'
  >
> {
  const emptyMetrics = {
    scorecard_binary_artifacts: null,
    scorecard_dangerous_workflow: null,
    scorecard_dependency_update_tool: null,
    scorecard_license: null,
    scorecard_pinned_dependencies: null,
    scorecard_permissions: null,
    scorecard_security_policy: null
  } as const
  if (!hash) return emptyMetrics

  const binary = process.env.SCORECARD_BINARY ?? 'scorecard'
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      binary,
      [`--local=${directory}`, `--commit=${hash}`, '--format=json'],
      { maxBuffer: /* 10 MB */ 10 * 1024 * 1024 }
    ))
  } catch (error) {
    throw new Error(
      `Scorecard failed for ${repoUrl} at commit ${hash} using ${binary}`,
      { cause: error }
    )
  }

  let result: ScorecardResult
  try {
    result = JSON.parse(stdout) as ScorecardResult
  } catch (error) {
    throw new Error(
      `Scorecard returned invalid JSON for ${repoUrl} at commit ${hash}`,
      { cause: error }
    )
  }
  if (!Array.isArray(result.checks)) {
    throw new Error(
      `Scorecard returned no checks for ${repoUrl} at commit ${hash}`
    )
  }

  const scores = new Map(
    result.checks
      .filter(
        (check): check is ScorecardCheck =>
          typeof check?.name === 'string' && typeof check?.score === 'number'
      )
      .map(({ name, score }) => [name, score])
  )
  return {
    scorecard_binary_artifacts: scores.get('Binary-Artifacts'),
    scorecard_dangerous_workflow: scores.get('Dangerous-Workflow'),
    scorecard_dependency_update_tool: scores.get('Dependency-Update-Tool'),
    scorecard_license: scores.get('License'),
    scorecard_pinned_dependencies: scores.get('Pinned-Dependencies'),
    scorecard_permissions: scores.get('Token-Permissions'),
    scorecard_security_policy: scores.get('Security-Policy')
  }
}

/**
 * Test whether a timestamp lies in a trailing time window.
 *
 * @param date The timestamp to test.
 * @param end The inclusive end of the window.
 * @param duration The length of the window.
 * @returns `true` when the timestamp is after `end - duration` and at or
 * before `end`.
 */
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

/**
 * Calculate contributor and concentration metrics for a commit set.
 *
 * @param commits Commits in the requested window.
 * @param allCommits All available commits used to find first contributions.
 * @param end The inclusive end of the requested window.
 * @param duration The window length, or `undefined` for all-time metrics.
 * @param suffix The suffix used in the returned metric names.
 * @returns Contributor count, bus factor, top-contributor share, and
 * new-contributor rate.
 * @remarks Authors are merged when their commit email addresses overlap.
 * `allCommits` is assumed to be ordered oldest-to-newest so the first
 * matching commit is each author's first commit. `commits` is assumed to be
 * the corresponding subset of `allCommits`.
 */
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
  console.log(
    `${authors.length} authors for ${suffix}: ${authors.map((a) => a.emails.join(', ')).join('; ')}`
  )

  const ordered = authors.map((c) => c.commits).sort((a, b) => b - a)
  const total = commits.length
  let accumulated = 0
  let busFactor = 0
  while (accumulated < total / 2 && busFactor < ordered.length) {
    accumulated += ordered[busFactor++]
  }

  // To find first-time contributions, we need to iterate through all commits
  // before and through the window, and record the first commit for each author.
  const firstCommitByAuthor = new Map<number, Temporal.Instant>()
  for (const commit of allCommits.filter(
    ({ date }) => Temporal.Instant.compare(date, end) <= 0
  )) {
    const authorIndex = authors.findIndex((a) =>
      a.emails.includes(commit.email)
    )
    if (authorIndex === -1) {
      console.error(
        `Commit ${commit.hash} by <${commit.email}> has no matching author in period ${suffix}`
      )
      continue
    }
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

/**
 * Divide two numbers, treating a zero denominator as an empty result.
 *
 * @param numerator The value to divide.
 * @param denominator The divisor.
 * @returns The quotient, or `0` when the denominator is zero.
 */
function normalizedDivide(numerator: number, denominator: number) {
  return denominator !== 0 ? numerator / denominator : 0
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

/**
 * Calculate normalized timestamp variation, returning zero for fewer than two
 * timestamps.
 *
 * @param instants Timestamps assumed to be ordered chronologically so adjacent
 * values represent consecutive events.
 * @returns The coefficient of variation of adjacent intervals, or `0` when
 * fewer than two timestamps are supplied.
 */
function normalizedCovBetweenInstants(instants: Temporal.Instant[]) {
  if (instants.length < 2) return 0
  return covBetweenInstants(instants)
}

/**
 * Calculate the coefficient of variation of adjacent timestamp intervals.
 *
 * @param instants At least two timestamps, preferably ordered chronologically.
 * @returns Standard deviation of adjacent interval lengths divided by their
 * mean.
 * @remarks Absolute differences prevent negative intervals, but meaningful
 * inter-commit and inter-tag metrics still assume chronological input.
 */
function covBetweenInstants(instants: Temporal.Instant[]) {
  const durationsMillis = instants
    .slice(1)
    .map((instant, i) => instant.since(instants[i]).abs().total('milliseconds'))
  const mean =
    durationsMillis.reduce((total, d) => total + d, 0) / durationsMillis.length
  const variance =
    durationsMillis.reduce((total, d) => total + Math.pow(d - mean, 2), 0) /
    durationsMillis.length
  return mean ? Math.sqrt(variance) / mean : 0
}

/**
 * Read the commit dates associated with all repository tags.
 *
 * @param git The SimpleGit instance for the cloned repository.
 * @returns One commit timestamp per tag.
 * @remarks Tags are assumed to resolve to commits with parseable dates. The
 * returned dates are sorted and are filtered to exclude dates after `CUTOFF`.
 */
async function readTagDates(git: SimpleGit) {
  const tags = await git.tags()
  const dates = await Promise.all(
    tags.all.map(async (tag) => {
      const log = await git.log(['-1', tag])
      return Temporal.Instant.from(log.latest?.date ?? '')
    })
  )
  return dates
    .sort((a, b) => Temporal.Instant.compare(a, b))
    .filter((date) => Temporal.Instant.compare(date, CUTOFF) <= 0)
}

/**
 * Measure the source tree at a repository commit.
 *
 * @param git The SimpleGit instance for the cloned repository.
 * @param hash The commit to inspect, or `undefined` when no commit exists.
 * @returns The line count and file count, or zeroes when `hash` is undefined.
 * @remarks Files are assumed to be text readable by `git.show`. Files that
 * cannot be read are omitted from the line count but remain in the file
 * listing, matching the best-effort behavior of the implementation.
 */
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
