import type { Db } from '../db';
import { songs } from '../db/schema';
import type { ObjectStorage } from '../storage/s3';

export interface OrphanScanResult {
	orphanKeys: string[];
	totalBucketKeys: number;
	totalReferencedKeys: number;
}

export interface DeadReference {
	videoId: string;
	field: 'audioKey' | 'coverKey';
	key: string;
}

export interface DeadReferenceScanResult {
	deadReferences: DeadReference[];
	totalBucketKeys: number;
	totalSongs: number;
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

	return {
		orphanKeys: bucketKeys.filter((key) => !referencedKeys.has(key)),
		totalBucketKeys: bucketKeys.length,
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
		db.select({ videoId: songs.videoId, audioKey: songs.audioKey, coverKey: songs.coverKey }).from(songs)
	]);

	const bucketKeySet = new Set(bucketKeys);
	const deadReferences: DeadReference[] = [];

	for (const row of songRows) {
		if (!bucketKeySet.has(row.audioKey)) {
			deadReferences.push({ videoId: row.videoId, field: 'audioKey', key: row.audioKey });
		}
		if (row.coverKey && !bucketKeySet.has(row.coverKey)) {
			deadReferences.push({ videoId: row.videoId, field: 'coverKey', key: row.coverKey });
		}
	}

	return { deadReferences, totalBucketKeys: bucketKeys.length, totalSongs: songRows.length };
}
