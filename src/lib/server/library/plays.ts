import { sql } from 'drizzle-orm';
import type { Db } from '../db';
import { userSongs } from '../db/schema';

/**
 * Records one play for this specific user/song pair — deliberately not a
 * global counter on `songs` (see the user_songs table comment in
 * schema.ts): songs are deduplicated and shared across users, so a global
 * count would let one user's listening make a song look artificially
 * popular in a different user's own eviction scoring, even if that user
 * never played it.
 *
 * A single upsert rather than a read-then-write: two plays for the same
 * user/song racing each other (e.g. a flaky connection causing a client
 * retry) both need to land as +1 each, not clobber one another — the
 * conflict clause's `+ 1` runs against the already-serialized row, not a
 * value read earlier in application code. Only touches the play-related
 * columns — cache_type (see setCachePreference in cache/preferences.ts)
 * is a separate concern sharing this same row and is left untouched here.
 */
export async function recordSongPlay(db: Db, userId: string, videoId: string): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(userSongs)
		.values({ userId, videoId, playCount: 1, lastPlayedAt: now })
		.onConflictDoUpdate({
			target: [userSongs.userId, userSongs.videoId],
			set: { playCount: sql`${userSongs.playCount} + 1`, lastPlayedAt: now, updatedAt: sql`(current_timestamp)` }
		});
}
