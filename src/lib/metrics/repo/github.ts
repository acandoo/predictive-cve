import type { Octokit } from 'octokit'

import { parseGithubRepoUrl } from '../../helpers/repo.ts'

/**
 * Retrieve GitHub activities and releases used by the CHAOSS metrics.
 *
 * Issues include pull requests in the GitHub Issues API. Reviews are included
 * as responses to pull requests, while comments cover both issues and pull
 * requests. Bot-authored responses are deliberately excluded.
 */
export async function findGithubMetrics(
  octokit: Octokit,
  repoUrl: string
): Promise<GithubMetrics> {
  const { owner, repo } = parseGithubRepoUrl(repoUrl)
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'all',
    per_page: 100
  })
  const activities = await Promise.all(
    issues.map(async (issue) => {
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        { owner, repo, issue_number: issue.number, per_page: 100 }
      )
      const responses = comments
        .filter(({ user }) => isHuman(user))
        .map(({ created_at }) => Temporal.Instant.from(created_at))

      if (issue.pull_request) {
        const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
          owner,
          repo,
          pull_number: issue.number,
          per_page: 100
        })
        responses.push(
          ...reviews
            .filter(
              ({ user, submitted_at }) =>
                isHuman(user) && typeof submitted_at === 'string'
            )
            .map(({ submitted_at }) => Temporal.Instant.from(submitted_at!))
        )
      }

      responses.sort((a, b) => Temporal.Instant.compare(a, b))
      return {
        openedAt: Temporal.Instant.from(issue.created_at),
        firstResponseAt: responses.find(
          (response) =>
            Temporal.Instant.compare(
              response,
              Temporal.Instant.from(issue.created_at)
            ) > 0
        ),
        closedAt: issue.closed_at
          ? Temporal.Instant.from(issue.closed_at)
          : undefined,
        isChangeRequest: !!issue.pull_request
      }
    })
  )
  const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
    owner,
    repo,
    per_page: 100
  })
  return {
    activities,
    releases: releases
      .filter((release) => release.published_at !== null)
      .map((release) => Temporal.Instant.from(release.published_at!))
  }
}
export type GithubActivity = {
  openedAt: Temporal.Instant
  firstResponseAt?: Temporal.Instant
  closedAt?: Temporal.Instant
  isChangeRequest: boolean
}

export type GithubMetrics = {
  activities: GithubActivity[]
  releases: Temporal.Instant[]
}
function isHuman(user: { type: string; login?: string } | null) {
  return !!user && user.type !== 'Bot' && !user.login?.endsWith('[bot]')
}
