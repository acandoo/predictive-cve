import type { Octokit } from 'octokit'

import { parseGithubRepoUrl } from '../../helpers/repo.ts'

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
export async function findRepoCves(
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
