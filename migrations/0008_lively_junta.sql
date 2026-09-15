ALTER TABLE `song_plays` RENAME TO `user_songs`;
--> statement-breakpoint
ALTER TABLE `user_songs` ADD `cache_type` text DEFAULT 'lazy' NOT NULL;
--> statement-breakpoint
-- Merge cache_preferences' pinned rows into user_songs — a row can exist in
-- one table but not the other (played but never pinned, or pinned but never
-- played), so this is an upsert per user/song pair, not a plain copy.
INSERT INTO `user_songs` (`user_id`, `video_id`, `play_count`, `last_played_at`, `cache_type`, `updated_at`)
SELECT `user_id`, `video_id`, 0, NULL, `cache_type`, `updated_at` FROM `cache_preferences`
WHERE true
ON CONFLICT (`user_id`, `video_id`) DO UPDATE SET `cache_type` = excluded.`cache_type`;
--> statement-breakpoint
DROP TABLE `cache_preferences`;
