CREATE TABLE `embedding_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `songs`(`video_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embedding_jobs_video_id_unique` ON `embedding_jobs` (`video_id`);--> statement-breakpoint
CREATE INDEX `idx_embedding_jobs_status` ON `embedding_jobs` (`status`);