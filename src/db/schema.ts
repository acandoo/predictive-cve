import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const reposTable = sqliteTable('repos_table', {
  name: text().notNull(),
  url: text().notNull(),
  id: int({ mode: 'number' }).primaryKey({ autoIncrement: true })
})

export const cvesTable = sqliteTable('cves_table', {
  cve_id: text().notNull(),
  description: text().notNull(),
  published_date: text().notNull(),
  last_modified_date: text().notNull(),
  cvss_score: text().notNull(),
  cvss_vector: text().notNull(),
  repo_id: int().notNull()
})
