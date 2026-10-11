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
import { SAMPLE_DURATION, CUTOFF } from './lib/constants.ts'

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

type GitCommit = {
  hash: string
  date: Temporal.Instant
  author: string
  insertions: number
  deletions: number
  files: number
}

type TimePeriod = {
  start: Temporal.Instant
  end: Temporal.Instant
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

function parseGithubRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const url = new URL(repoUrl)
  const [owner, repo] = url.pathname.split('/').filter(Boolean)

  return { owner, repo }
}

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
      author: '%an'
    }
  })

  return Promise.all(
    output.all.map(async ({ hash, date, author }) => {
      const { insertions, deletions, files } = await git.diffSummary([
        `${hash}^!`
      ])
      return {
        hash,
        date: Temporal.Instant.from(date),
        author,
        insertions,
        deletions,
        files: files.length
      }
    })
  )
}

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
    firstDate.since(lastDate).total({ unit: 'milliseconds' }) / durationMs
  )
  console.log(`Building ${sampleCount} sample rows for ${repoUrl}`)
  const tagDates = await readTagDates(git)

  return Promise.all(
    Array.from({ length: sampleCount }, (_, index) => {
      const start = firstDate.add({ milliseconds: index * durationMs })
      console.log(
        `Building sample row for ${repoUrl} from ${start} to ${start.add({ milliseconds: durationMs })}`
      )
      return buildSampleRow(
        git,
        repoUrl,
        commits,
        repoCves,
        {
          start,
          end: start.add({ milliseconds: durationMs })
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
  const commits90d = commitsInPeriod(commits, period.end, 90)
  console.log(
    `Filtered commits for repo ${repoUrl} for 90 days: ${commits90d.length}`
  )
  const commits365d = commitsInPeriod(commits, period.end, 365)
  console.log(
    `Filtered commits for repo ${repoUrl} for 365 days: ${commits365d.length}`
  )
  return {
    date_unix: new Date(period.end.epochMilliseconds),
    repo_url: repoUrl,
    cves_reported_365d: repoCves.filter(({ publishedAt }) =>
      isInPeriod(publishedAt, period.end, 365)
    ).length,
    ...contributorMetrics(commits90d, allCommits, period.end, 90, '90d'),
    ...contributorMetrics(commits365d, allCommits, period.end, 365, '365d'),
    ...contributorMetrics(allCommits, allCommits, period.end, undefined, 'all'),
    commits_90d: commits90d.length,
    commits_365d: commits365d.length,
    commits_all: allCommits.length,
    repo_age_days: Math.floor(elapsedDays(commits[0].date, period.end)),
    ...(await treeMetrics(git, allCommits.at(-1)?.hash)),
    cov_inter_commit_90d: averageInterval(commits90d),
    cov_inter_commit_365d: averageInterval(commits365d),
    cov_inter_commit_all: averageInterval(allCommits),
    cov_inter_tag_90d: averageDateInterval(
      datesInPeriod(tagDates, period.end, 90)
    ),
    cov_inter_tag_365d: averageDateInterval(
      datesInPeriod(tagDates, period.end, 365)
    ),
    cov_inter_tag_all: averageDateInterval(
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
  days: number
): boolean {
  const start = end.subtract({ hours: days * 24 })
  return (
    Temporal.Instant.compare(date, start) > 0 &&
    Temporal.Instant.compare(date, end) <= 0
  )
}

function elapsedDays(
  earlier: Temporal.Instant,
  later: Temporal.Instant
): number {
  return later.since(earlier).total({ unit: 'days' })
}

function commitsInPeriod(
  commits: GitCommit[],
  end: Temporal.Instant,
  days: number
) {
  return commits.filter(({ date }) => isInPeriod(date, end, days))
}

function contributorMetrics(
  commits: GitCommit[],
  allCommits: GitCommit[],
  end: Temporal.Instant,
  days: number | undefined,
  suffix: '90d' | '365d' | 'all'
) {
  const counts = new Map<string, number>()
  for (const commit of commits) {
    counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1)
  }
  const ordered = [...counts.values()].sort((a, b) => b - a)
  const total = commits.length
  let accumulated = 0
  let busFactor = 0
  while (accumulated < total / 2 && busFactor < ordered.length) {
    accumulated += ordered[busFactor++]
  }
  const firstCommitByAuthor = new Map<string, Temporal.Instant>()
  for (const commit of allCommits) {
    if (!firstCommitByAuthor.has(commit.author)) {
      firstCommitByAuthor.set(commit.author, commit.date)
    }
  }
  const newContributors = [...firstCommitByAuthor.values()].filter(
    (date) =>
      Temporal.Instant.compare(date, end) <= 0 &&
      (days === undefined || isInPeriod(date, end, days))
  ).length
  return {
    [`contributors_${suffix}`]: counts.size,
    [`bus_factor_${suffix}`]: busFactor,
    [`top_contributor_share_${suffix}`]: total ? (ordered[0] ?? 0) / total : 0,
    [`new_contributor_rate_${suffix}`]: counts.size
      ? newContributors / counts.size
      : 0
  }
}

function churn(commits: GitCommit[]) {
  return commits.reduce(
    (total, commit) => total + commit.insertions + commit.deletions,
    0
  )
}

function averageInterval(commits: GitCommit[]) {
  if (commits.length < 2) return null
  return (
    commits.reduce(
      (total, commit, index) =>
        index === 0
          ? total
          : total + elapsedDays(commits[index - 1].date, commit.date),
      0
    ) /
    (commits.length - 1)
  )
}

function datesInPeriod(
  dates: Temporal.Instant[],
  end: Temporal.Instant,
  days: number
) {
  return dates.filter((date) => isInPeriod(date, end, days))
}

function averageDateInterval(dates: Temporal.Instant[]) {
  if (dates.length < 2) return null
  return (
    dates
      .sort(Temporal.Instant.compare)
      .reduce(
        (total, date, index) =>
          index === 0 ? total : total + elapsedDays(dates[index - 1], date),
        0
      ) /
    (dates.length - 1)
  )
}

async function readTagDates(git: ReturnType<typeof simpleGit>) {
  const tags = (await git.raw(['tag', '--list'])).split('\n').filter(Boolean)
  const dates = await Promise.all(
    tags.map(async (tag) => {
      const date = await git.raw(['log', '-1', '--format=%aI', tag])
      return Temporal.Instant.from(date.trim())
    })
  )
  return dates
}

async function treeMetrics(
  git: ReturnType<typeof simpleGit>,
  hash: string | undefined
) {
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
