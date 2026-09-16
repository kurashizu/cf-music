ALTER TABLE `playlists` ADD `type` text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE `playlists` ADD `tag` text;--> statement-breakpoint
ALTER TABLE `playlists` ADD `facet` text;