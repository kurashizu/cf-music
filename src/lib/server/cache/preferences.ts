import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import { userSongs, playlists, playlistSongs, songs } from '../db/schema';
import { chunk } from '../../shared/chunk';

// Same D1 bound-parameter ceiling as findKnownVideoIds (see that file for
// the "too many SQL variables" failure this batches around).
const VIDEO_IDS_BATCH_SIZE = 90;

export type CacheType = 'lazy' | 'pinned';

export interface CachePreferenceEntry {
	videoId: string;
	title: string;
	fileSizeBytes: number;
	cacheType: CacheType;
}

/**
 * Every song in a user's library annotated with its cache preference —
 * songs with no user_songs row default to 'lazy' (the schema's own
 * default), since that row is only created the first time this user plays
 * or pins the song, not at import time.
 */
export async function listCachePreferences(db: Db, userId: string): Promise<CachePreferenceEntry[]> {
	const librarySongs = await db
		.selectDistinct({
			videoId: songs.videoId,
			title: songs.title,
			fileSizeBytes: songs.fileSizeBytes
		})
		.from(playlistSongs)
		.innerJoin(playlists, eq(playlistSongs.playlistId, playlists.id))
		.innerJoin(songs, eq(playlistSongs.videoId, songs.videoId))
		.where(eq(playlists.userId, userId));

	if (librarySongs.length === 0) return [];

	const pinnedVideoIds = new Set<string>();
	for (const batch of chunk(librarySongs.map((s) => s.videoId), VIDEO_IDS_BATCH_SIZE)) {
		const rows = await db
			.select({ videoId: userSongs.videoId })
			.from(userSongs)
			.where(
				and(
					eq(userSongs.userId, userId),
					eq(userSongs.cacheType, 'pinned'),
					inArray(userSongs.videoId, batch)
				)
			);
		for (const row of rows) pinnedVideoIds.add(row.videoId);
	}

	return librarySongs.map((song) => ({
		...song,
		cacheType: pinnedVideoIds.has(song.videoId) ? 'pinned' : 'lazy'
	}));
}

/**
 * Sets one song's cache preference for a user. Upserts rather than
 * deleting the row when set back to 'lazy': unlike the old standalone
 * cache_preferences table, this row (user_songs) may also be carrying this
 * user's play history for the song, which a delete would destroy. A
 * missing row still means "never played and never pinned" — it's only
 * once either happens that the row exists at all.
 */
export async function setCachePreference(
	db: Db,
	userId: string,
	videoId: string,
	cacheType: CacheType
): Promise<void> {
	await db
		.insert(userSongs)
		.values({ userId, videoId, cacheType })
		.onConflictDoUpdate({
			target: [userSongs.userId, userSongs.videoId],
			set: { cacheType, updatedAt: new Date().toISOString() }
		});
}
