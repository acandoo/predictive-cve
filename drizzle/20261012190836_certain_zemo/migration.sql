ALTER TABLE `samples` ADD `chaoss_time_to_first_response_90d` real;--> statement-breakpoint
ALTER TABLE `samples` ADD `chaoss_time_to_first_response_365d` real;--> statement-breakpoint
ALTER TABLE `samples` ADD `chaoss_time_to_first_response_all` real;--> statement-breakpoint
ALTER TABLE `samples` ADD `chaoss_change_request_closure_ratio_90d` real;--> statement-breakpoint
ALTER TABLE `samples` ADD `chaoss_change_request_closure_ratio_365d` real;--> statement-breakpoint
ALTER TABLE `samples` ADD `chaoss_change_request_closure_ratio_all` real;--> statement-breakpoint
ALTER TABLE `samples` ADD `chaoss_release_frequency_90d` integer;--> statement-breakpoint
ALTER TABLE `samples` ADD `chaoss_release_frequency_365d` integer;--> statement-breakpoint
ALTER TABLE `samples` ADD `chaoss_release_frequency_all` integer;