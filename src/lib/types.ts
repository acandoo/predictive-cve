import type { samples } from '../db/schema.ts'

export type GitCommit = {
  hash: string
  date: Temporal.Instant
  name: string
  email: string
  insertions: number
  deletions: number
  files: number
}

export type TimePeriod = {
  start: Temporal.Instant
  end: Temporal.Instant
}
export type SampleRow = typeof samples.$inferInsert
