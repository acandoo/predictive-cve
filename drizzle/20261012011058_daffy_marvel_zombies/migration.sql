CREATE TABLE `cves` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`cve_id` text NOT NULL UNIQUE,
	`published_at` integer NOT NULL,
	`repo_url` text NOT NULL,
	CONSTRAINT `fk_cves_repo_url_repos_url_fk` FOREIGN KEY (`repo_url`) REFERENCES `repos`(`url`)
);
--> statement-breakpoint
CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`url` text NOT NULL UNIQUE,
	`bucket` text
);
--> statement-breakpoint
CREATE TABLE `samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`date_unix` integer,
	`repo_url` text NOT NULL,
	`cves_reported_365d` integer,
	`cov_inter_commit_90d` real,
	`cov_inter_commit_365d` real,
	`cov_inter_commit_all` real,
	`cov_inter_tag_90d` real,
	`cov_inter_tag_365d` real,
	`cov_inter_tag_all` real,
	`contributors_90d` integer,
	`contributors_365d` integer,
	`contributors_all` integer NOT NULL,
	`commits_90d` integer,
	`commits_365d` integer,
	`commits_all` integer NOT NULL,
	`bus_factor_90d` integer,
	`bus_factor_365d` integer,
	`bus_factor_all` integer NOT NULL,
	`top_contributor_share_90d` real,
	`top_contributor_share_365d` real,
	`top_contributor_share_all` real NOT NULL,
	`new_contributor_rate_90d` real,
	`new_contributor_rate_365d` real,
	`new_contributor_rate_all` real NOT NULL,
	`churn_90d` real,
	`churn_365d` real,
	`churn_all` real NOT NULL,
	`repo_age_days` integer NOT NULL,
	`loc` integer NOT NULL,
	`file_count` integer NOT NULL,
	`scorecard_binary_artifacts` real,
	`scorecard_dangerous_workflow` real,
	CONSTRAINT `fk_samples_repo_url_repos_url_fk` FOREIGN KEY (`repo_url`) REFERENCES `repos`(`url`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sample_index` ON `samples` (`date_unix`,`repo_url`);