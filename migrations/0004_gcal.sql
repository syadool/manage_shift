CREATE TABLE `gcal_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`refresh_token_enc` text NOT NULL,
	`calendar_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`dirty` integer DEFAULT 0 NOT NULL,
	`title_mode` text DEFAULT 'symbol' NOT NULL,
	`workplace_name` text,
	`last_synced_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_verifier` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
