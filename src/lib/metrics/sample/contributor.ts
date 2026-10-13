import type { GitAuthor } from '../../helpers/authors.ts'
import { normalizedDivide } from '../../helpers/math.ts'
import { isInPeriod } from '../../helpers/math.ts'
import type { GitCommit } from '../../types.ts'

/**
 * Calculate contributor and concentration metrics for a commit set.
 *
 * @param commits Commits in the requested window.
 * @param allCommits All available commits up to window end used to find first contributions.
 * @param authors The total list of authors.
 * @param end The inclusive end of the requested window.
 * @param duration The window length, or `undefined` for all-time metrics.
 * @param suffix The suffix used in the returned metric names.
 * @returns Contributor count, bus factor, top-contributor share, and
 * new-contributor rate.
 */
export function contributorMetrics<T extends '90d' | '365d' | 'all'>(
  commits: GitCommit[],
  allCommits: GitCommit[],
  allAuthors: GitAuthor[],
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
  const authors = allAuthors.filter(({ names, emails }) =>
    commits.some(
      (commit) => emails.includes(commit.email) || names.includes(commit.name)
    )
  )
  console.log(`Filtered authors: ${authors.length}`)
  const ordered = authors
    .map(
      ({ names, emails }) =>
        commits.filter(
          (commit) =>
            emails.includes(commit.email) || names.includes(commit.name)
        ).length
    )
    .filter((count) => count > 0)
    .sort((a, b) => b - a)
  const total = commits.length
  let accumulated = 0
  /** Number of authors contributing at least half of the total commits */
  let busFactor = 0
  console.log(`Total commits: ${total}, Ordered: ${ordered.length}`)
  while (accumulated < total / 2 && busFactor < ordered.length) {
    accumulated += ordered[busFactor++]
  }
  console.log(
    `Accumulated: ${accumulated}, Total: ${total}, Bus Factor: ${busFactor}`
  )

  // To find first-time contributions, we need to iterate through all commits
  // before and through the window, and record the first commit for each author.
  const firstCommitByAuthor = new Map<number, Temporal.Instant>()
  for (const commit of allCommits) {
    const authorIndex = authors.findIndex((a) =>
      a.emails.includes(commit.email)
    )
    if (authorIndex === -1) {
      // console.error(
      //   `Commit ${commit.hash} by <${commit.email}> has no matching author in period ${suffix}`
      // )
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
