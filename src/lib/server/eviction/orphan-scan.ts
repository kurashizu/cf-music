import { and, eq, isNull, count } from 'drizzle-orm';
import type { Db } from '../db';
import { songs, playlistSongs } from '../db/schema';
import type { ObjectStorage } from '../storage/s3';
import { recordAuditEvent } from '../audit/log';

export interface OrphanScanResult {
	orphanKeys: string[];
	totalBucketKeys: number;
	totalReferencedKeys: number;
}

export interface DeadReference {
	videoId: string;
	title: string;
	field: 'audioKey' | 'coverKey';
	key: string;
}

export interface DeadReferenceScanResult {
	deadReferences: DeadReference[];
	totalBucketKeys: number;
	totalSongs: number;
}

export interface UnreferencedSong {
	videoId: string;
	title: string;
}

export interface UnreferencedSongScanResult {
	unreferencedSongs: UnreferencedSong[];
	totalSongs: number;
}

// Prefixes for things deliberately kept in the same bucket that aren't a
// song's audioKey/coverKey and never will be — e.g. ci-state/, where the
// import pipeline's yt-dlp cookies file lives (see YT_COOKIES_OBJECT_KEY in
// docker/import/import.py). Without this, every scan below would report
// them as orphaned (true, in the narrow sense that no `songs` row points at
// them) and an admin could delete something that's still very much in use.
const NON_SONG_KEY_PREFIXES = ['ci-state/'];

function isSongNamespaceKey(key: string): boolean {
	return !NON_SONG_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Finds S3 objects with no corresponding row in `songs` at all — every
 * legitimate object is either a song's audioKey or coverKey, and every song
 * row is guaranteed reachable through at least one playlist (imports always
 * land in a playlist, eviction deletes the row and its objects together —
 * see evictSongForUser), so anything in the bucket outside that set can only
 * be leftover from an interrupted/failed operation, never a real reference.
 * Report-only: callers decide whether to actually delete `orphanKeys`.
 */
export async function findOrphanedObjects(db: Db, storage: ObjectStorage): Promise<OrphanScanResult> {
	const [bucketKeys, songRows] = await Promise.all([
		storage.listAllKeys(),
		db.select({ audioKey: songs.audioKey, coverKey: songs.coverKey }).from(songs)
	]);

	const referencedKeys = new Set<string>();
	for (const row of songRows) {
		referencedKeys.add(row.audioKey);
		if (row.coverKey) referencedKeys.add(row.coverKey);
	}

	const songNamespaceKeys = bucketKeys.filter(isSongNamespaceKey);

	return {
		orphanKeys: songNamespaceKeys.filter((key) => !referencedKeys.has(key)),
		totalBucketKeys: songNamespaceKeys.length,
		totalReferencedKeys: referencedKeys.size
	};
}

/**
 * The inverse of findOrphanedObjects: `songs` rows whose audioKey/coverKey
 * point at an object that no longer exists in the bucket — eviction deletes
 * the S3 object before the D1 row (see evictSongForUser), so a crash or
 * thrown error in between that specific window leaves a row referencing a
 * dead key. Any later playback attempt for that video would 404 on a valid-
 * looking presigned URL with no indication why; this is the only detector
 * for that direction (findOrphanedObjects only catches the S3-without-D1
 * case). Report-only, same as findOrphanedObjects — deciding what to do
 * with a dead reference (re-import, delete the row) is a judgment call, not
 * something safe to automate.
 */
export async function findDeadSongReferences(db: Db, storage: ObjectStorage): Promise<DeadReferenceScanResult> {
	const [bucketKeys, songRows] = await Promise.all([
		storage.listAllKeys(),
		db.select({ videoId: songs.videoId, title: songs.title, audioKey: songs.audioKey, coverKey: songs.coverKey }).from(songs)
	]);

	const bucketKeySet = new Set(bucketKeys);
	const deadReferences: DeadReference[] = [];

	for (const row of songRows) {
		if (!bucketKeySet.has(row.audioKey)) {
			deadReferences.push({ videoId: row.videoId, title: row.title, field: 'audioKey', key: row.audioKey });
		}
		if (row.coverKey && !bucketKeySet.has(row.coverKey)) {
			deadReferences.push({ videoId: row.videoId, title: row.title, field: 'coverKey', key: row.coverKey });
		}
	}

	return { deadReferences, totalBucketKeys: bucketKeys.length, totalSongs: songRows.length };
}

/**
 * A third orphan direction, distinct from both findOrphanedObjects
 * (S3-without-D1) and findDeadSongReferences (D1-referencing-missing-S3):
 * `songs` rows with real, intact S3 objects, but that no playlist_songs
 * row reaches at all — invisible in every user's library, contributing
 * nothing but silent storage usage. This should never happen (every
 * import links its song into a target playlist, and eviction deletes the
 * row itself once the last reference is gone — see evictSongForUser), so
 * a row here means something upstream left the two out of sync (an
 * interrupted operation, manual data surgery, a stale test artifact) —
 * this is report-only, same as the other two scans; resolveUnreferencedSong
 * is the separate action that actually deletes one.
 */
export async function findUnreferencedSongs(db: Db): Promise<UnreferencedSongScanResult> {
	const [rows, [{ totalSongs }]] = await Promise.all([
		db
			.select({ videoId: songs.videoId, title: songs.title })
			.from(songs)
			.leftJoin(playlistSongs, eq(playlistSongs.videoId, songs.videoId))
			.where(isNull(playlistSongs.videoId)),
		db.select({ totalSongs: count() }).from(songs)
	]);

	return { unreferencedSongs: rows, totalSongs };
}

/**
 * Resolves one dead reference found by findDeadSongReferences — the two
 * fields need different actions, not a single "delete it" for both: a dead
 * audioKey means the song has no audio at all, so the row itself is
 * deleted (its playlist_songs rows cascade); a dead coverKey means the
 * song still plays fine, just without cover art, so only the cover
 * reference is cleared rather than destroying an otherwise-working song
 * over a cosmetic issue. `actorId` is the admin performing this, recorded
 * the same way other admin actions are (see recordAuditEvent's userId vs
 * actorId distinction).
 *
 * Returns whether the write actually changed anything, via `.returning()`
 * rather than assuming it did: two admins resolving the same reference at
 * nearly the same time both pass the caller's "is this still dead" recheck
 * and both call this, but only the first's DELETE/UPDATE affects a row —
 * the second's affects zero, and only the caller that actually changed
 * something should record an audit event, or the log would show the same
 * action twice for something that only happened once.
 */
export async function resolveDeadSongReference(
	db: Db,
	actorId: string,
	reference: DeadReference
): Promise<{ resolved: boolean }> {
	if (reference.field === 'audioKey') {
		const deleted = await db.delete(songs).where(eq(songs.videoId, reference.videoId)).returning({ videoId: songs.videoId });
		if (deleted.length === 0) return { resolved: false };

		await recordAuditEvent(db, {
			actorId,
			eventType: 'manual_delete',
			targetType: 'song',
			targetId: reference.videoId,
			detail: { reason: 'dead_audio_reference', key: reference.key }
		});
		return { resolved: true };
	}

	const updated = await db
		.update(songs)
		.set({ coverKey: null })
		.where(and(eq(songs.videoId, reference.videoId), eq(songs.coverKey, reference.key)))
		.returning({ videoId: songs.videoId });
	if (updated.length === 0) return { resolved: false };

	await recordAuditEvent(db, {
		actorId,
		eventType: 'cover_reference_cleared',
		targetType: 'song',
		targetId: reference.videoId,
		detail: { reason: 'dead_cover_reference', key: reference.key }
	});
	return { resolved: true };
}

/**
 * Deletes one unreferenced song found by findUnreferencedSongs — its D1 row
 * and its S3 objects, the same as evictSongForUser's hard-delete branch
 * (there's no user's own playlist references to remove first here, since
 * the whole point is that nothing references it). D1 row deleted before
 * S3 objects for the same reason as evictSongForUser: a crash between the
 * two leaves a stray S3 object with no songs row, which is exactly what
 * findOrphanedObjects already detects and is safe to clean up — the
 * opposite ordering risks a songs row surviving with a dead key instead,
 * undetectable except by a second, judgment-requiring scan.
 *
 * Returns whether the delete actually happened, via `.returning()` rather
 * than assuming it did — the same double-resolve race as
 * resolveDeadSongReference (two admins acting on the same stale scan
 * result) applies here too.
 */
export async function resolveUnreferencedSong(
	db: Db,
	storage: ObjectStorage,
	actorId: string,
	videoId: string
): Promise<{ resolved: boolean }> {
	const deleted = await db.delete(songs).where(eq(songs.videoId, videoId)).returning({
		videoId: songs.videoId,
		title: songs.title,
		audioKey: songs.audioKey,
		coverKey: songs.coverKey,
		fileSizeBytes: songs.fileSizeBytes
	});
	if (deleted.length === 0) return { resolved: false };
	const song = deleted[0];

	await storage.deleteObjects([song.audioKey, ...(song.coverKey ? [song.coverKey] : [])]);

	await recordAuditEvent(db, {
		actorId,
		eventType: 'manual_delete',
		targetType: 'song',
		targetId: videoId,
		detail: { reason: 'unreferenced_song', title: song.title, fileSizeBytes: song.fileSizeBytes }
	});
	return { resolved: true };
}
