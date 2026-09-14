import { eq, and, count } from 'drizzle-orm';
import type { Db } from '../db';
import { songs, playlists, playlistSongs } from '../db/schema';
import type { ObjectStorage } from '../storage/s3';
import { recordAuditEvent } from '../audit/log';
import { checkQuota, type QuotaCheckResult } from './quota';
import { getUserStorageUsageBytes, getUserQuotaBytes, getUserEvictionCandidates } from './usage';

export interface EvictionPreview {
	videoId: string;
	title: string;
	fileSizeBytes: number;
}

/**
 * Runs the same quota check that a real import would, without performing
 * one — used to preview which songs *would* be evicted before the user
 * confirms an import that needs space (per the design: eviction always
 * requires an upfront confirmation dialog, auto-evict included).
 */
export async function previewEvictionForImport(
	db: Db,
	userId: string,
	incomingFileSizeBytes: number
): Promise<QuotaCheckResult> {
	const [usedBytes, quotaBytes, candidates] = await Promise.all([
		getUserStorageUsageBytes(db, userId),
		getUserQuotaBytes(db, userId),
		getUserEvictionCandidates(db, userId)
	]);

	return checkQuota({
		fileSizeBytes: incomingFileSizeBytes,
		quotaBytes,
		usedBytes,
		existingSongs: candidates
	});
}

/**
 * Evicts a single song from `userId`'s library: removes the reference from
 * every playlist *this user* owns, then — only if no playlist (belonging to
 * any user) still references the song — deletes the song row and its S3
 * objects (audio + cover). Sharing with other users' playlists is preserved.
 */
export async function evictSongForUser(
	db: Db,
	storage: ObjectStorage,
	userId: string,
	videoId: string,
	reason: 'auto_evict' | 'manual_delete' = 'auto_evict'
): Promise<void> {
	const song = await db.query.songs.findFirst({ where: eq(songs.videoId, videoId) });
	if (!song) return; // already gone; nothing to do

	// Remove this user's own playlist references to the song.
	const ownPlaylistIds = (
		await db.query.playlists.findMany({ where: eq(playlists.userId, userId), columns: { id: true } })
	).map((p) => p.id);

	for (const playlistId of ownPlaylistIds) {
		await db
			.delete(playlistSongs)
			.where(and(eq(playlistSongs.playlistId, playlistId), eq(playlistSongs.videoId, videoId)));
	}

	const [{ remainingReferences }] = await db
		.select({ remainingReferences: count() })
		.from(playlistSongs)
		.where(eq(playlistSongs.videoId, videoId));

	if (remainingReferences === 0) {
		await storage.deleteObjects([song.audioKey, ...(song.coverKey ? [song.coverKey] : [])]);
		await db.delete(songs).where(eq(songs.videoId, videoId));
	}

	await recordAuditEvent(db, {
		userId,
		eventType: reason === 'manual_delete' ? 'manual_delete' : 'evict',
		targetType: 'song',
		targetId: videoId,
		detail: { title: song.title, fileSizeBytes: song.fileSizeBytes, hardDeleted: remainingReferences === 0 }
	});
}

/** Evicts every song in `plan.toEvict`, in order, for the given user. */
export async function executeEvictionPlan(
	db: Db,
	storage: ObjectStorage,
	userId: string,
	videoIds: string[]
): Promise<void> {
	for (const videoId of videoIds) {
		await evictSongForUser(db, storage, userId, videoId, 'auto_evict');
	}
}
