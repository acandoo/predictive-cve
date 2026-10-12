ALTER TABLE `samples` RENAME COLUMN `scorecard_permissions` TO `scorecard_token_permissions`;--> statement-breakpoint
ALTER TABLE `samples` ADD `scorecard_vulnerabilities` real;--> statement-breakpoint
ALTER TABLE `samples` DROP COLUMN `scorecard_dependency_update_tool`;