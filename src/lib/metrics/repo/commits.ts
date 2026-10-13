import type { SimpleGit } from 'simple-git'

import { clone } from '../../helpers/cloner.ts'
import { CUTOFF } from '../../helpers/constants.ts'
import type { GitCommit } from '../../types.ts'

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
export async function readCommits(
  git: SimpleGit,
  repoUrl: string,
  directory: string
): Promise<GitCommit[]> {
  console.log(`Cloning ${repoUrl} into ${directory}`)
  await clone(repoUrl, directory)
  console.log(`Cloned ${repoUrl} into ${directory}`)

  const output = await git.log({
    format: {
      hash: '%H',
      date: '%aI',
      name: '%an',
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
      .map(async ({ name, hash, date, email }) => {
        const { insertions, deletions, files } = await git.diffSummary([
          `${hash}^!`
        ])
        return {
          hash,
          date: Temporal.Instant.from(date),
          name,
          email,
          insertions,
          deletions,
          files: files.length
        }
      })
  )
}
