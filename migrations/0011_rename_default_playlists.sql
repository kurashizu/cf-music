-- Data-only migration, not a schema change: renames every user's default
-- playlist from "Imports" to "All Imported" for clarity, now that renaming
-- the default playlist is blocked going forward (see renamePlaylist in
-- src/lib/server/library/playlists.ts) — existing rows still need a one-time
-- backfill since that guard only stops future renames, not the name already
-- stored from before it existed.
UPDATE playlists
SET name = 'All Imported'
WHERE id IN (SELECT default_playlist_id FROM users WHERE default_playlist_id IS NOT NULL)
  AND name = 'Imports';
