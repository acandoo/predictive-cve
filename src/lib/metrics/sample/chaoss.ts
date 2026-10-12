import { normalizedDivide } from '../../helpers/math.ts'
import type { GitCommit } from '../../types.ts'
import type { GithubMetrics } from '../repo/github.ts'

export function chaossMetrics<T extends '90d' | '365d' | 'all'>(
  githubMetrics: GithubMetrics,
  commits: GitCommit[],
  end: Temporal.Instant,
  duration: Temporal.Duration | undefined,
  suffix: T
): {
  [
    K in
      | `chaoss_time_to_first_response_${T}`
      | `chaoss_change_request_closure_ratio_${T}`
      | `chaoss_release_frequency_${T}`
  ]: number
} {
  const start = duration ? end.subtract(duration) : undefined
  const inWindow = (date: Temporal.Instant) =>
    Temporal.Instant.compare(date, end) <= 0 &&
    (!start || Temporal.Instant.compare(date, start) > 0)
  const activities = githubMetrics.activities.filter(({ openedAt }) =>
    inWindow(openedAt)
  )
  const responseTimes = activities
    .filter(
      ({ firstResponseAt }) =>
        firstResponseAt && Temporal.Instant.compare(firstResponseAt, end) <= 0
    )
    .map(({ openedAt, firstResponseAt }) =>
      firstResponseAt!.since(openedAt).total('days')
    )
  const changeRequests = githubMetrics.activities.filter(
    ({ isChangeRequest }) => isChangeRequest
  )
  const closed = changeRequests.filter(
    ({ closedAt }) => closedAt && inWindow(closedAt)
  ).length
  const open = changeRequests.filter(
    ({ openedAt, closedAt }) =>
      Temporal.Instant.compare(openedAt, end) <= 0 &&
      (!closedAt || Temporal.Instant.compare(closedAt, end) > 0)
  ).length
  const releases = githubMetrics.releases.filter(inWindow).length
  const result = Object.create(null)
  result[`chaoss_time_to_first_response_${suffix}`] = normalizedDivide(
    responseTimes.reduce((total, days) => total + days, 0),
    responseTimes.length
  )
  result[`chaoss_change_request_closure_ratio_${suffix}`] = normalizedDivide(
    open,
    closed
  )

  result[`chaoss_release_frequency_${suffix}`] = releases
  return result
}
