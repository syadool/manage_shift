CREATE TABLE `unknown_shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`member_id` text NOT NULL,
	`date` text NOT NULL,
	`symbol` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `unknown_shifts_user_date_idx` ON `unknown_shifts` (`user_id`,`date`);--> statement-breakpoint
CREATE INDEX `unknown_shifts_member_date_idx` ON `unknown_shifts` (`member_id`,`date`);