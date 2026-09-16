CREATE TABLE `tag_vectors` (
	`tag` text PRIMARY KEY NOT NULL,
	`facet` text NOT NULL,
	`embedding` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `songs` ADD `auto_tags` text;