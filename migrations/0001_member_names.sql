CREATE TABLE `member_names` (
	`user_id` text NOT NULL,
	`member_id` text NOT NULL,
	`normalized` text NOT NULL,
	PRIMARY KEY(`user_id`, `normalized`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_names_member_idx` ON `member_names` (`member_id`);