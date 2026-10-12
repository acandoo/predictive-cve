import type { SimpleGit } from 'simple-git'

import { CUTOFF } from './constants.ts'

export function parseGithubRepoUrl(repoUrl: string): {
  owner: string
  repo: string
} {
  const url = new URL(repoUrl)
  const [owner, repo] = url.pathname.split('/').filter(Boolean)

  return { owner, repo }
} /**
 * Read the commit dates associated with all repository tags.
 *
 * @param git The SimpleGit instance for the cloned repository.
 * @returns One commit timestamp per tag.
 * @remarks Tags are assumed to resolve to commits with parseable dates. The
 * returned dates are sorted and are filtered to exclude dates after `CUTOFF`.
 */
export async function readTagDates(git: SimpleGit) {
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
