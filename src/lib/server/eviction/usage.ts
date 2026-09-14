import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { songs, playlists, playlistSongs, users } from '../db/schema';
import type { EvictionCandidate } from './score';
import { recordAuditEvent } from '../audit/log';

/**
 * A user's storage usage is the sum of file sizes for every distinct song
 * reachable through any playlist they own. Because songs are deduplicated
 * globally by video_id (shared S3 object across users), a song shared with
 * another user still counts at full size against *this* user's quota — the
 * quota models "how much of my allowance this song uses", not literal disk
 * bytes, so dedup savings don't change per-user accounting.
 *
 * The DISTINCT here is load-bearing, not decorative: the same song can be
 * reachable through more than one of this user's own playlists (that's the
 * whole point of playlist_songs being many-to-many), and a plain sum over
 * the joined rows would double-count its file size once per playlist it's
 * in — this query counts it once regardless of how many of the user's
 * playlists reference it.
 */
export async function getUserStorageUsageBytes(db: Db, userId: string): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`coalesce(sum(distinct_songs.file_size_bytes), 0)` })
		.from(
			db
				.selectDistinct({ videoId: songs.videoId, fileSizeBytes: songs.fileSizeBytes })
				.from(playlistSongs)
				.innerJoin(playlists, eq(playlistSongs.playlistId, playlists.id))
				.innerJoin(songs, eq(playlistSongs.videoId, songs.videoId))
				.where(eq(playlists.userId, userId))
				.as('distinct_songs')
		);

	return row.total;
}

export async function getUserQuotaBytes(db: Db, userId: string): Promise<number> {
	const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
	if (!user) throw new Error(`User ${userId} not found`);
	return user.storageQuotaBytes;
}

/** Admin-only: changes a user's storage quota, recording who did it and the before/after values. */
export async function setUserQuotaBytes(
	db: Db,
	userId: string,
	newQuotaBytes: number,
	actorId: string
): Promise<void> {
	const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
	if (!user) throw new Error(`User ${userId} not found`);

	await db.update(users).set({ storageQuotaBytes: newQuotaBytes }).where(eq(users.id, userId));

	await recordAuditEvent(db, {
		userId,
		actorId,
		eventType: 'quota_adjusted',
		targetType: 'user',
		targetId: userId,
		detail: { previousQuotaBytes: user.storageQuotaBytes, newQuotaBytes }
	});
}

/** Distinct songs in a user's library, annotated for eviction scoring. */
export async function getUserEvictionCandidates(db: Db, userId: string): Promise<EvictionCandidate[]> {
	const rows = await db
		.selectDistinct({
			videoId: songs.videoId,
			playCount: songs.playCount,
			lastPlayedAt: songs.lastPlayedAt,
			importedAt: songs.importedAt,
			fileSizeBytes: songs.fileSizeBytes
		})
		.from(playlistSongs)
		.innerJoin(playlists, eq(playlistSongs.playlistId, playlists.id))
		.innerJoin(songs, eq(playlistSongs.videoId, songs.videoId))
		.where(eq(playlists.userId, userId));

	return rows.map((r) => ({
		videoId: r.videoId,
		playCount: r.playCount,
		lastPlayedAt: r.lastPlayedAt ? new Date(r.lastPlayedAt) : null,
		importedAt: new Date(r.importedAt),
		fileSizeBytes: r.fileSizeBytes
	}));
}
