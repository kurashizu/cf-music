import type { Db } from '../db';
import { songs } from '../db/schema';
import type { ObjectStorage } from '../storage/s3';

export interface OrphanScanResult {
	orphanKeys: string[];
	totalBucketKeys: number;
	totalReferencedKeys: number;
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
