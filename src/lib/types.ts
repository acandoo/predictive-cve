export type GitCommit = {
  hash: string
  date: Temporal.Instant
  email: string
  insertions: number
  deletions: number
  files: number
}

export type TimePeriod = {
  start: Temporal.Instant
  end: Temporal.Instant
}
