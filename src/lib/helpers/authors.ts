import type { GitCommit } from '../types.ts'

export type GitAuthor = {
  names: string[]
  emails: string[]
}

export async function readAuthors(commits: GitCommit[]): Promise<GitAuthor[]> {
  const authors: Map<number, GitAuthor> = new Map()
  let authorCount = 0
  for (const { name, email } of commits) {
    const [first, ...rest] = authors
      .entries()
      .filter(([, a]) => a.emails.includes(email) || a.names.includes(name))
    if (!first) {
      authors.set(authorCount++, {
        names: [name],
        emails: [email]
      })
      continue
    }
    // at leat one existing author
    const firstAuthor = first[1]
    for (const [key, author] of rest) {
      firstAuthor.emails = [
        ...new Set([...firstAuthor.emails, ...author.emails])
      ]
      firstAuthor.names = [...new Set([...firstAuthor.names, ...author.names])]
      authors.delete(key)
    }
  }
  return Object.values(authors)
}
