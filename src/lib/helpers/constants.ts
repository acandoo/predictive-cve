import os from 'node:os'
import path from 'node:path'

export const SAMPLE_DURATION = Temporal.Duration.from({ hours: 24 * 365 })
export const CUTOFF = Temporal.Instant.from('2025-04-01T00:00:00Z')
export const DURATION_90D = Temporal.Duration.from({ hours: 24 * 90 })
export const DURATION_365D = Temporal.Duration.from({ hours: 24 * 365 })
export const REPO_DIR = path.join(os.tmpdir(), 'repos')
export const MAX_CONCURRENT_CLONES = 3
export const MAX_CONCURRENT_REPOS = 4

export const BLOCKLIST = [
  'https://github.com/liferay/liferay-portal', // how tf am i supposed to parse a 900,000 commit repository
  'https://github.com/ComposioHQ/composio-js' // moved to plain composio
]
