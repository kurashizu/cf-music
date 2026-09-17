CREATE TABLE `song_embeddings` (
	`video_id` text PRIMARY KEY NOT NULL,
	`vector` blob NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `songs`(`video_id`) ON UPDATE no action ON DELETE cascade
);
