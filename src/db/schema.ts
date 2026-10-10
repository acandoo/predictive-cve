import {
  int,
  sqliteTable,
  text,
  real,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'

export const repos = sqliteTable('repos', {
  id: int().primaryKey({ autoIncrement: true }),
  url: text().notNull().unique(),
  bucket: text({ enum: ['training', 'validation', 'test'] })
})

export const cves = sqliteTable('cves', {
  id: int().primaryKey({ autoIncrement: true }),
  cve_id: text().notNull().unique(),
  published_at: int({ mode: 'timestamp' }).notNull(),
  repo_url: text()
    .notNull()
    .references(() => repos.url)
})

export const samples = sqliteTable(
  'samples',
  {
    id: int().primaryKey({ autoIncrement: true }),
    date_unix: int({ mode: 'timestamp' }),
    repo_url: text()
      .notNull()
      .references(() => repos.url),
    cves_reported_365d: int(),

    cov_inter_commit_90d: real(),
    cov_inter_commit_365d: real(),
    cov_inter_commit_all: real(),
    cov_inter_tag_90d: real(),
    cov_inter_tag_365d: real(),
    cov_inter_tag_all: real(),
    contributors_90d: int(),
    contributors_365d: int(),
    contributors_all: int(),
    commits_90d: int(),
    commits_365d: int(),
    commits_all: int(),
    bus_factor_90d: int(),
    bus_factor_365d: int(),
    bus_factor_all: int(),
    top_contributor_share_90d: real(),
    top_contributor_share_365d: real(),
    top_contributor_share_all: real(),
    new_contributor_rate_90d: real(),
    new_contributor_rate_365d: real(),
    new_contributor_rate_all: real(),
    churn_90d: real(),
    churn_365d: real(),
    churn_all: real(),
    repo_age_days: int(),
    loc: int(),
    file_count: int()
  },
  (t) => [uniqueIndex('sample_index').on(t.date_unix, t.repo_url)]
)
