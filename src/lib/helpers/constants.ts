import os from 'node:os'
import path from 'node:path'

export const SAMPLE_DURATION = Temporal.Duration.from({ hours: 24 * 365 })
export const CUTOFF = Temporal.Instant.from('2025-04-01T00:00:00Z')
export const DURATION_90D = Temporal.Duration.from({ hours: 24 * 90 })
export const DURATION_365D = Temporal.Duration.from({ hours: 24 * 365 })
export const REPO_DIR = path.join(os.tmpdir(), 'repos')
export const MAX_CONCURRENT_CLONES = 5
export const MAX_CONCURRENT_REPOS = 10
