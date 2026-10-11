export function parseGithubRepoUrl(
  repoUrl: string
): { owner: string; repo: string } {
  const url = new URL(repoUrl)
  const [owner, repo] = url.pathname.split('/').filter(Boolean)

  return { owner, repo }
}
