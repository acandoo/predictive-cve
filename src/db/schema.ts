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
    /* Number of CVEs reported in the next 365 days */
    cves_reported_365d: int(),
    /* Coefficient of variation for inter-commit times */
    cov_inter_commit_90d: real(),
    cov_inter_commit_365d: real(),
    cov_inter_commit_all: real(),
    /* Coefficient of variation for inter-tag times */
    cov_inter_tag_90d: real(),
    cov_inter_tag_365d: real(),
    cov_inter_tag_all: real(),
    /* Number of contributors */
    contributors_90d: int(),
    contributors_365d: int(),
    contributors_all: int().notNull(),
    /* Number of commits */
    commits_90d: int(),
    commits_365d: int(),
    commits_all: int().notNull(),
    /* Fewest authors who together made 50% of the commits */
    bus_factor_90d: int(),
    bus_factor_365d: int(),
    bus_factor_all: int().notNull(),
    /* Top author's commits divided by total commits */
    top_contributor_share_90d: real(),
    top_contributor_share_365d: real(),
    top_contributor_share_all: real().notNull(),
    /* Authors with no commit before the window start, divided by active authors */
    new_contributor_rate_90d: real(),
    new_contributor_rate_365d: real(),
    new_contributor_rate_all: real().notNull(),
    /* Lines added plus deleted */
    churn_90d: real(),
    churn_365d: real(),
    churn_all: real().notNull(),
    /* Age of the repository in days */
    repo_age_days: int().notNull(),
    /* Lines of code */
    loc: int().notNull(),
    /* Number of files in the repository */
    file_count: int().notNull(),
    /* OpenSSF Scorecard metrics */
    scorecard_binary_artifacts: real(),
    scorecard_dangerous_workflow: real(),
    scorecard_dependency_update_tool: real(),
    scorecard_license: real(),
    scorecard_pinned_dependencies: real(),
    scorecard_permissions: real(),
    scorecard_security_policy: real()
  },
  (t) => [uniqueIndex('sample_index').on(t.date_unix, t.repo_url)]
)
