import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Octokit } from 'octokit'

import { findGithubMetrics } from './github.ts'

type GraphqlVariables = Record<string, unknown>

function graphqlClient(
  responses: Array<{
    variables?: GraphqlVariables
    result: unknown
  }>
): Octokit {
  let responseIndex = 0
  return {
    graphql: async (_query: string, variables?: GraphqlVariables) => {
      const response = responses[responseIndex++]
      assert.ok(response, 'Unexpected GraphQL request')
      if (response.variables) {
        assert.deepStrictEqual(variables, response.variables)
      }
      return response.result
    }
  } as unknown as Octokit
}

function pageInfo(hasNextPage = false, endCursor: string | null = null) {
  return { hasNextPage, endCursor }
}

function normalizeMetrics(
  metrics: Awaited<ReturnType<typeof findGithubMetrics>>
) {
  return {
    activities: metrics.activities.map((activity) => ({
      ...activity,
      openedAt: activity.openedAt.toString(),
      firstResponseAt: activity.firstResponseAt?.toString(),
      closedAt: activity.closedAt?.toString()
    })),
    releases: metrics.releases.map((release) => release.toString())
  }
}

await test('findGithubMetrics paginates and returns filtered activities and releases', async (t) => {
  const octokit = graphqlClient([
    {
      variables: {
        owner: 'acandoo',
        repo: 'predictive-cve',
        issueCursor: null,
        pullRequestCursor: null,
        releaseCursor: null,
        includeIssues: true,
        includePullRequests: true,
        includeReleases: true
      },
      result: {
        repository: {
          issues: {
            nodes: [
              {
                number: 1,
                createdAt: '2025-01-01T00:00:00Z',
                closedAt: '2025-01-03T00:00:00Z',
                comments: {
                  nodes: [
                    {
                      createdAt: '2025-01-01T01:00:00Z',
                      author: { __typename: 'User', login: 'alice' }
                    },
                    {
                      createdAt: '2025-01-01T02:00:00Z',
                      author: { __typename: 'Bot', login: 'release-bot' }
                    }
                  ],
                  pageInfo: pageInfo(true, 'comments-2')
                }
              }
            ],
            pageInfo: pageInfo()
          },
          pullRequests: {
            nodes: [
              {
                number: 2,
                createdAt: '2025-01-02T00:00:00Z',
                closedAt: null,
                comments: {
                  nodes: [],
                  pageInfo: pageInfo()
                },
                reviews: {
                  nodes: [
                    {
                      submittedAt: '2025-01-02T02:00:00Z',
                      author: { __typename: 'User', login: 'reviewer' }
                    },
                    {
                      submittedAt: '2025-01-02T01:00:00Z',
                      author: null
                    }
                  ],
                  pageInfo: pageInfo(true, 'reviews-2')
                }
              }
            ],
            pageInfo: pageInfo()
          },
          releases: {
            nodes: [
              { publishedAt: '2025-02-01T00:00:00Z' },
              { publishedAt: null }
            ],
            pageInfo: pageInfo(true, 'releases-2')
          }
        }
      }
    },
    {
      variables: {
        owner: 'acandoo',
        repo: 'predictive-cve',
        issueCursor: null,
        pullRequestCursor: null,
        releaseCursor: 'releases-2',
        includeIssues: false,
        includePullRequests: false,
        includeReleases: true
      },
      result: {
        repository: {
          releases: {
            nodes: [{ publishedAt: '2025-03-01T00:00:00Z' }],
            pageInfo: pageInfo()
          }
        }
      }
    },
    {
      variables: {
        owner: 'acandoo',
        repo: 'predictive-cve',
        number: 1,
        commentCursor: 'comments-2',
        reviewCursor: null,
        includeComments: true,
        includeReviews: false
      },
      result: {
        repository: {
          issue: {
            comments: {
              nodes: [
                {
                  createdAt: '2025-01-01T03:00:00Z',
                  author: { __typename: 'User', login: 'bob' }
                }
              ],
              pageInfo: pageInfo()
            }
          },
          pullRequest: null
        }
      }
    },
    {
      variables: {
        owner: 'acandoo',
        repo: 'predictive-cve',
        number: 2,
        commentCursor: null,
        reviewCursor: 'reviews-2',
        includeComments: false,
        includeReviews: true
      },
      result: {
        repository: {
          issue: { comments: undefined },
          pullRequest: {
            reviews: {
              nodes: [
                {
                  submittedAt: '2025-01-02T03:00:00Z',
                  author: { __typename: 'User', login: 'carol' }
                }
              ],
              pageInfo: pageInfo()
            }
          }
        }
      }
    }
  ])

  const metrics = await findGithubMetrics(
    octokit,
    'https://github.com/acandoo/predictive-cve'
  )

  t.assert.snapshot(normalizeMetrics(metrics))
})

await test('does not paginate activity connections past the CHAOSS cutoff', async () => {
  const octokit = graphqlClient([
    {
      variables: {
        owner: 'acandoo',
        repo: 'predictive-cve',
        issueCursor: null,
        pullRequestCursor: null,
        releaseCursor: null,
        includeIssues: true,
        includePullRequests: true,
        includeReleases: true
      },
      result: {
        repository: {
          issues: {
            nodes: [
              {
                number: 3,
                createdAt: '2025-04-01T00:00:01Z',
                closedAt: null,
                comments: {
                  nodes: [],
                  pageInfo: pageInfo()
                }
              }
            ],
            pageInfo: pageInfo(true, 'issues-after-cutoff')
          },
          pullRequests: {
            nodes: [
              {
                number: 4,
                createdAt: '2025-04-01T00:00:01Z',
                closedAt: null,
                comments: {
                  nodes: [],
                  pageInfo: pageInfo()
                },
                reviews: {
                  nodes: [],
                  pageInfo: pageInfo()
                }
              }
            ],
            pageInfo: pageInfo(true, 'pull-requests-after-cutoff')
          },
          releases: {
            nodes: [],
            pageInfo: pageInfo()
          }
        }
      }
    }
  ])

  const metrics = await findGithubMetrics(
    octokit,
    'https://github.com/acandoo/predictive-cve'
  )

  assert.deepStrictEqual(normalizeMetrics(metrics), {
    activities: [],
    releases: []
  })
})
