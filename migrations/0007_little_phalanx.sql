CREATE TABLE `song_plays` (
	`user_id` text NOT NULL,
	`video_id` text NOT NULL,
	`play_count` integer DEFAULT 0 NOT NULL,
	`last_played_at` text,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	PRIMARY KEY(`user_id`, `video_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `songs`(`video_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `songs` DROP COLUMN `play_count`;--> statement-breakpoint
ALTER TABLE `songs` DROP COLUMN `last_played_at`;