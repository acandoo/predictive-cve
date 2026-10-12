import type { SimpleGit } from 'simple-git'

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
export async function treeMetrics(git: SimpleGit, hash: string | undefined) {
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
