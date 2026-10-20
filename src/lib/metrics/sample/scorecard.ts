import { execFile } from 'child_process'
import type { ExecException } from 'child_process'
import { promisify } from 'util'

import type { SampleRow } from '../../types.ts'

export const execFileAsync = promisify(execFile)

type ScorecardCheck = {
  name: string
  score: number
}
type ScorecardResult = {
  checks: ScorecardCheck[]
}
/**
 * Run OpenSSF Scorecard against the commit selected for a sample period.
 *
 * @param directory The directory containing the cloned repository.
 * @param hash The commit selected for the sample period, or `undefined` when
 * no commit exists before the period end.
 * @param repoUrl The repository URL, used to identify failures in logs.
 * @returns The Scorecard check scores mapped to sample columns.
 * @remarks Scorecard is expected to be available as `scorecard` on `PATH`, or
 * at the path supplied by `SCORECARD_BINARY`. Checks that are not returned by
 * Scorecard are stored as `null`.
 */
export async function scorecardMetrics(
  directory: string,
  hash: string | undefined,
  repoUrl: string
): Promise<
  Pick<
    SampleRow,
    | 'scorecard_binary_artifacts'
    | 'scorecard_dangerous_workflow'
    | 'scorecard_vulnerabilities'
    | 'scorecard_license'
    | 'scorecard_pinned_dependencies'
    | 'scorecard_token_permissions'
    | 'scorecard_security_policy'
  >
> {
  const emptyMetrics = {
    scorecard_binary_artifacts: null,
    scorecard_dangerous_workflow: null,
    scorecard_vulnerabilities: null,
    scorecard_license: null,
    scorecard_pinned_dependencies: null,
    scorecard_token_permissions: null,
    scorecard_security_policy: null
  } as const
  if (!hash) return emptyMetrics

  const binary = process.env.SCORECARD_BINARY ?? 'scorecard'
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      binary,
      [`--local=${directory}`, `--commit=${hash}`, '--format=json'],
      { maxBuffer: /* 10 MB */ 10 * 1024 * 1024 }
    ))
  } catch (error) {
    console.error(
      `Scorecard failed for ${repoUrl} at commit ${hash} using ${binary}`,
      { cause: error }
    )
    stdout = (error as ExecException).stdout as string
  }

  let result: ScorecardResult
  try {
    result = JSON.parse(stdout) as ScorecardResult
  } catch (error) {
    throw new Error(
      `Scorecard returned invalid JSON for ${repoUrl} at commit ${hash}`,
      { cause: error }
    )
  }
  if (!Array.isArray(result.checks)) {
    throw new Error(
      `Scorecard returned no checks for ${repoUrl} at commit ${hash}`
    )
  }

  const scores = new Map(
    result.checks
      .filter(
        (check): check is ScorecardCheck =>
          typeof check?.name === 'string' && typeof check?.score === 'number'
      )
      .map(({ name, score }) => [name, score])
  )
  return {
    scorecard_binary_artifacts: scores.get('Binary-Artifacts'),
    scorecard_dangerous_workflow: scores.get('Dangerous-Workflow'),
    scorecard_license: scores.get('License'),
    scorecard_pinned_dependencies: scores.get('Pinned-Dependencies'),
    scorecard_security_policy: scores.get('Security-Policy'),
    scorecard_token_permissions: scores.get('Token-Permissions'),
    scorecard_vulnerabilities: scores.get('Vulnerabilities')
  }
}
