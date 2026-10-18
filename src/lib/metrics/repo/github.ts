import { validate } from '@octokit/graphql-schema'
import type { Octokit } from 'octokit'

import { CUTOFF } from '../../helpers/constants.ts'
import { parseGithubRepoUrl } from '../../helpers/repo.ts'

const repositoryQuery = validateQuery(
  `
  query RepositoryMetrics(
    $owner: String!
    $repo: String!
    $issueCursor: String
    $pullRequestCursor: String
    $releaseCursor: String
    $includeIssues: Boolean!
    $includePullRequests: Boolean!
    $includeReleases: Boolean!
  ) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, after: $issueCursor, states: [OPEN, CLOSED], orderBy: { field: CREATED_AT, direction: ASC }) @include(if: $includeIssues) {
        nodes {
          number
          createdAt
          closedAt
          comments(first: 100) {
            nodes {
              createdAt
              author {
                __typename
                login
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      pullRequests(first: 100, after: $pullRequestCursor, states: [OPEN, CLOSED], orderBy: { field: CREATED_AT, direction: ASC }) @include(if: $includePullRequests) {
        nodes {
          number
          createdAt
          closedAt
          reviews(first: 100) {
            nodes {
              submittedAt
              author {
                __typename
                login
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          comments(first: 100) {
            nodes {
              createdAt
              author {
                __typename
                login
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      releases(first: 100, after: $releaseCursor) @include(if: $includeReleases) {
        nodes {
          publishedAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
    }
`,
  'RepositoryMetrics'
)

const issueDetailsQuery = validateQuery(
  `
  query IssueDetails(
    $owner: String!
    $repo: String!
    $number: Int!
    $commentCursor: String
    $reviewCursor: String
    $includeComments: Boolean!
    $includeReviews: Boolean!
  ) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        comments(first: 100, after: $commentCursor) @include(if: $includeComments) {
          nodes {
            createdAt
            author {
              __typename
              login
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
      pullRequest(number: $number) @include(if: $includeReviews) {
        reviews(first: 100, after: $reviewCursor) {
          nodes {
            submittedAt
            author {
              __typename
              login
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`,
  'IssueDetails'
)

function validateQuery(query: string, name: string): string {
  const errors = validate(query)
  if (errors.length > 0) {
    throw new Error(
      `Invalid GitHub GraphQL query ${name}: ${errors
        .map((error) => error.message)
        .join('; ')}`
    )
  }
  return query
}

/**
 * Retrieve GitHub activities and releases used by the CHAOSS metrics.
 *
 * Issues and pull requests are fetched separately. Reviews are included as
 * responses to pull requests, while comments cover both issues and pull
 * requests. Activity created after the sampling cutoff is ignored because it
 * cannot contribute to a CHAOSS sample. Bot-authored responses are
 * deliberately excluded.
 */
export async function findGithubMetrics(
  octokit: Octokit,
  repoUrl: string
): Promise<GithubMetrics> {
  const { owner, repo } = parseGithubRepoUrl(repoUrl)
  const issues: GithubIssue[] = []
  const releases: GithubRelease[] = []
  let issueCursor: string | null = null
  let pullRequestCursor: string | null = null
  let releaseCursor: string | null = null
  let issuesFetched = false
  let pullRequestsFetched = false
  let releasesFetched = false

  do {
    const result: GithubRepositoryQuery = await octokit.graphql(
      repositoryQuery,
      {
        owner,
        repo,
        issueCursor,
        pullRequestCursor,
        releaseCursor,
        includeIssues: !issuesFetched || issueCursor !== null,
        includePullRequests: !pullRequestsFetched || pullRequestCursor !== null,
        includeReleases: !releasesFetched || releaseCursor !== null
      }
    )
    if (result.repository.issues) {
      issuesFetched = true
      issues.push(
        ...result.repository.issues.nodes
          .filter(({ createdAt }) => isAtOrBeforeCutoff(createdAt))
          .map((issue) => ({
            ...issue,
            reviews: { nodes: [], pageInfo: emptyPageInfo() },
            isChangeRequest: false
          }))
      )
      issueCursor =
        result.repository.issues.pageInfo.hasNextPage &&
        result.repository.issues.nodes.every(({ createdAt }) =>
          isAtOrBeforeCutoff(createdAt)
        )
          ? result.repository.issues.pageInfo.endCursor
          : null
    }
    if (result.repository.pullRequests) {
      pullRequestsFetched = true
      issues.push(
        ...result.repository.pullRequests.nodes
          .filter(({ createdAt }) => isAtOrBeforeCutoff(createdAt))
          .map((pullRequest) => ({
            ...pullRequest,
            isChangeRequest: true
          }))
      )
      pullRequestCursor =
        result.repository.pullRequests.pageInfo.hasNextPage &&
        result.repository.pullRequests.nodes.every(({ createdAt }) =>
          isAtOrBeforeCutoff(createdAt)
        )
          ? result.repository.pullRequests.pageInfo.endCursor
          : null
    }
    if (result.repository.releases) {
      releasesFetched = true
      releases.push(...result.repository.releases.nodes)
      releaseCursor = result.repository.releases.pageInfo.hasNextPage
        ? result.repository.releases.pageInfo.endCursor
        : null
    }
  } while (
    issueCursor !== null ||
    pullRequestCursor !== null ||
    releaseCursor !== null
  )

  const activities = await Promise.all(
    issues.map((issue) => toActivity(octokit, owner, repo, issue))
  )
  return {
    activities,
    releases: releases
      .filter((release) => release.publishedAt !== null)
      .map((release) => Temporal.Instant.from(release.publishedAt!))
  }
}

type GithubUser = {
  __typename: string
  login: string
}

type GithubComment = {
  createdAt: string
  author: GithubUser | null
}

type GithubReview = {
  submittedAt: string | null
  author: GithubUser | null
}

type GithubPageInfo = {
  hasNextPage: boolean
  endCursor: string | null
}

type GithubIssue = {
  number: number
  createdAt: string
  closedAt: string | null
  isChangeRequest: boolean
  comments: {
    nodes: GithubComment[]
    pageInfo: GithubPageInfo
  }
  reviews: {
    nodes: GithubReview[]
    pageInfo: GithubPageInfo
  }
}

type GithubRelease = {
  publishedAt: string | null
}

type GithubRepositoryQuery = {
  repository: {
    issues?: {
      nodes: Omit<GithubIssue, 'reviews' | 'isChangeRequest'>[]
      pageInfo: GithubPageInfo
    }
    pullRequests?: {
      nodes: Omit<GithubIssue, 'isChangeRequest'>[]
      pageInfo: GithubPageInfo
    }
    releases?: {
      nodes: GithubRelease[]
      pageInfo: GithubPageInfo
    }
  }
}

async function toActivity(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue: GithubIssue
): Promise<GithubActivity> {
  const comments = [...issue.comments.nodes]
  const reviews = [...issue.reviews.nodes]
  let commentCursor = issue.comments.pageInfo.hasNextPage
    ? issue.comments.pageInfo.endCursor
    : null
  let reviewCursor = issue.reviews.pageInfo.hasNextPage
    ? issue.reviews.pageInfo.endCursor
    : null

  while (commentCursor !== null || reviewCursor !== null) {
    const result = await octokit.graphql<{
      repository: {
        issue: {
          comments?: { nodes: GithubComment[]; pageInfo: GithubPageInfo }
        }
        pullRequest: {
          reviews?: { nodes: GithubReview[]; pageInfo: GithubPageInfo }
        } | null
      }
    }>(issueDetailsQuery, {
      owner,
      repo,
      number: issue.number,
      commentCursor,
      reviewCursor,
      includeComments: commentCursor !== null,
      includeReviews: reviewCursor !== null
    })
    if (result.repository.issue.comments) {
      comments.push(...result.repository.issue.comments.nodes)
      commentCursor = result.repository.issue.comments.pageInfo.hasNextPage
        ? result.repository.issue.comments.pageInfo.endCursor
        : null
    }
    if (result.repository.pullRequest?.reviews) {
      reviews.push(...result.repository.pullRequest.reviews.nodes)
      reviewCursor = result.repository.pullRequest.reviews.pageInfo.hasNextPage
        ? result.repository.pullRequest.reviews.pageInfo.endCursor
        : null
    }
  }

  const openedAt = Temporal.Instant.from(issue.createdAt)
  const responses = [
    ...comments
      .filter(({ author }) => isHuman(author))
      .map(({ createdAt }) => Temporal.Instant.from(createdAt)),
    ...reviews
      .filter(
        ({ author, submittedAt }) => isHuman(author) && submittedAt !== null
      )
      .map(({ submittedAt }) => Temporal.Instant.from(submittedAt!))
  ].sort((a, b) => Temporal.Instant.compare(a, b))

  return {
    openedAt,
    firstResponseAt: responses.find(
      (response) => Temporal.Instant.compare(response, openedAt) > 0
    ),
    closedAt: issue.closedAt
      ? Temporal.Instant.from(issue.closedAt)
      : undefined,
    isChangeRequest: issue.isChangeRequest
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
function isHuman(user: GithubUser | null) {
  return !!user && user.__typename !== 'Bot' && !user.login?.endsWith('[bot]')
}

function isAtOrBeforeCutoff(date: string) {
  return Temporal.Instant.compare(Temporal.Instant.from(date), CUTOFF) <= 0
}

function emptyPageInfo(): GithubPageInfo {
  return { hasNextPage: false, endCursor: null }
}
