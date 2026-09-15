CREATE TABLE `quota_reservations` (
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`video_id` text NOT NULL,
	`estimated_bytes` integer NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	PRIMARY KEY(`job_id`, `video_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_quota_reservations_user_id` ON `quota_reservations` (`user_id`);