DROP INDEX `imports_user_idx`;--> statement-breakpoint
ALTER TABLE `imports` ADD `content_type` text DEFAULT 'image/jpeg' NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `parse_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `error` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `parse_token` text;--> statement-breakpoint
CREATE INDEX `imports_user_created_idx` ON `imports` (`user_id`,`created_at`);