import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import { cachePreferences, playlists, playlistSongs, songs } from '../db/schema';
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
 * songs with no cache_preferences row default to 'lazy' (the schema's own
 * default), since that row is only created the first time a preference is
 * explicitly set, not at import time.
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
			.select({ videoId: cachePreferences.videoId })
			.from(cachePreferences)
			.where(
				and(
					eq(cachePreferences.userId, userId),
					eq(cachePreferences.cacheType, 'pinned'),
					inArray(cachePreferences.videoId, batch)
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
 * Sets one song's cache preference for a user. Setting back to 'lazy' (the
 * default) deletes the row rather than storing it explicitly — there's
 * nothing meaningful to persist once a song is no longer pinned, and it
 * keeps listCachePreferences' "no row = lazy" assumption accurate without
 * needing to sweep stale rows later.
 */
export async function setCachePreference(
	db: Db,
	userId: string,
	videoId: string,
	cacheType: CacheType
): Promise<void> {
	if (cacheType === 'lazy') {
		await db
			.delete(cachePreferences)
			.where(and(eq(cachePreferences.userId, userId), eq(cachePreferences.videoId, videoId)));
		return;
	}

	await db
		.insert(cachePreferences)
		.values({ userId, videoId, cacheType: 'pinned' })
		.onConflictDoUpdate({
			target: [cachePreferences.userId, cachePreferences.videoId],
			set: { cacheType: 'pinned', updatedAt: new Date().toISOString() }
		});
}
