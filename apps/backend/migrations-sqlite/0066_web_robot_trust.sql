CREATE TABLE `web_robot_configuration` (
	`id` text PRIMARY KEY NOT NULL,
	`robot_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`recipe` text NOT NULL,
	`recipe_version` integer NOT NULL,
	`recipe_hash` text NOT NULL,
	`scope` text NOT NULL,
	`contract` text NOT NULL,
	`verification_plan` text NOT NULL,
	`source_assessment` text NOT NULL,
	`scope_evidence` text NOT NULL,
	`count_signals` text NOT NULL,
	`configuration_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`robot_id`) REFERENCES `web_robot`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `web_robot_configuration_robotId_idx` ON `web_robot_configuration` (`robot_id`);--> statement-breakpoint
CREATE INDEX `web_robot_configuration_status_idx` ON `web_robot_configuration` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `web_robot_configuration_robot_hash_unique` ON `web_robot_configuration` (`robot_id`,`configuration_hash`);--> statement-breakpoint
ALTER TABLE `web_robot` ADD `active_configuration_id` text;--> statement-breakpoint
ALTER TABLE `web_robot` ADD `pending_configuration_id` text;--> statement-breakpoint
ALTER TABLE `web_robot` ADD `last_verified_run_id` text;--> statement-breakpoint
ALTER TABLE `web_robot` ADD `last_verified_run_at` integer;--> statement-breakpoint
ALTER TABLE `web_robot` ADD `last_published_run_id` text;--> statement-breakpoint
ALTER TABLE `web_robot` ADD `last_published_run_at` integer;--> statement-breakpoint
ALTER TABLE `web_robot` ADD `last_published_entity_count` integer;--> statement-breakpoint
ALTER TABLE `web_robot` ADD `last_published_entity_unit` text;--> statement-breakpoint
CREATE INDEX `web_robot_activeConfigurationId_idx` ON `web_robot` (`active_configuration_id`);--> statement-breakpoint
CREATE INDEX `web_robot_pendingConfigurationId_idx` ON `web_robot` (`pending_configuration_id`);--> statement-breakpoint
CREATE INDEX `web_robot_lastPublishedRunId_idx` ON `web_robot` (`last_published_run_id`);--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `configuration_id` text REFERENCES `web_robot_configuration`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `configuration_hash` text;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `scope_snapshot` text;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `contract_snapshot` text;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `verification_plan_snapshot` text;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `execution_status` text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `trust_status` text;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `trust_basis` text;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `trust_summary` text;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `progress` text;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `publication_status` text DEFAULT 'not_evaluated' NOT NULL;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `trust_report_path` text;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `trust_report_hash` text;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `execution_error_message` text;--> statement-breakpoint
ALTER TABLE `web_robot_run` ADD `publication_error_message` text;--> statement-breakpoint
CREATE INDEX `web_robot_run_configurationId_idx` ON `web_robot_run` (`configuration_id`);--> statement-breakpoint
CREATE INDEX `web_robot_run_executionStatus_idx` ON `web_robot_run` (`execution_status`);--> statement-breakpoint
CREATE INDEX `web_robot_run_trustStatus_idx` ON `web_robot_run` (`trust_status`);--> statement-breakpoint
CREATE INDEX `web_robot_run_publicationStatus_idx` ON `web_robot_run` (`publication_status`);
--> statement-breakpoint
UPDATE `web_robot_run` SET `execution_status` = 'succeeded' WHERE `status` IN ('completed', 'partial');--> statement-breakpoint
UPDATE `web_robot_run` SET `execution_status` = 'running' WHERE `status` = 'running';--> statement-breakpoint
UPDATE `web_robot_run` SET `execution_status` = 'failed' WHERE `status` = 'failed';--> statement-breakpoint
UPDATE `web_robot_run` SET `execution_status` = 'cancelled' WHERE `status` = 'cancelled';--> statement-breakpoint
UPDATE `scheduled_job` SET `status` = 'paused', `locked_at` = NULL, `locked_by` = NULL
	WHERE `id` IN (SELECT `scheduled_job_id` FROM `web_robot` WHERE `scheduled_job_id` IS NOT NULL);
