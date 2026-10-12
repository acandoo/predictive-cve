import { normalizedDivide } from '../../helpers/math.ts'
import { isInPeriod } from '../../helpers/math.ts'
import type { GitCommit } from '../../types.ts'

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
export function contributorMetrics<T extends '90d' | '365d' | 'all'>(
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
    names: string[]
    emails: string[]
    commits: number
  }> = []
  // this logic assumes that no two authors in a repo have the same name or email
  // from previous experience, it's not uncommon for authors to have multiple names or emails
  // so we deduplicate that here.
  for (const { name, email } of commits) {
    const existing = [
      ...authors
        .filter((c) => c.emails.includes(email) || c.names.includes(name))
        .entries()
    ]
    if (existing.length > 0) {
      const [first, ...rest] = existing
      first[1].commits += rest.reduce((total, [, c]) => total + c.commits, 0)
      first[1].emails.push(...rest.flatMap(([, c]) => c.emails))
      first[1].names.push(...rest.flatMap(([, c]) => c.names))
      for (const [index] of rest) {
        authors.splice(index, 1)
      }
    } else {
      authors.push({
        names: [name],
        emails: [email],
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
