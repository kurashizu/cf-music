ALTER TABLE `playlists` ADD `kind` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_playlists_user_id_kind` ON `playlists` (`user_id`,`kind`);