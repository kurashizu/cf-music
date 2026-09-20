import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { quotaReservations } from '../db/schema';
import { getUserQuotaBytes, getUserStorageUsageBytes } from '../eviction/usage';

export interface ReserveQuotaResult {
	reserved: boolean;
	/** What the caller can still fit right now, after this call (whether or not it succeeded). */
	remainingBytes: number;
}

async function getUserReservedBytes(db: Db, userId: string): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`coalesce(sum(estimated_bytes), 0)` })
		.from(quotaReservations)
		.where(eq(quotaReservations.userId, userId));
	return row.total;
}

/**
 * Atomically claims `estimatedBytes` of a user's remaining quota for one
 * song, or fails without claiming anything if it wouldn't fit — called
 * right before each song's download starts (not once per whole batch),
 * closing the race where two concurrent imports both check quota against
 * the same "before either" usage figure and, together, exceed it.
 *
 * The atomicity comes from doing the check and the write as a single
 * INSERT ... SELECT ... WHERE statement, not from any lock: SQLite
 * serializes writes to the same database file one at a time regardless of
 * how many concurrent callers there are, so a second concurrent call's
 * WHERE clause can never evaluate against a state that doesn't already
 * include the first call's just-committed reservation. A plain "read
 * reserved bytes, check in application code, then INSERT" would NOT be
 * atomic — a second call's read could land in the gap between the first
 * call's read and its write.
 */
export async function reserveQuota(
	db: Db,
	userId: string,
	jobId: string,
	videoId: string,
	estimatedBytes: number
): Promise<ReserveQuotaResult> {
	const [quotaBytes, usageBytes] = await Promise.all([
		getUserQuotaBytes(db, userId),
		getUserStorageUsageBytes(db, userId)
	]);

	// Not expressible with Drizzle's query builder (there's no real table to
	// select constants FROM, and the builder requires one) — an INSERT ...
	// SELECT ... WHERE with no FROM clause is plain valid SQLite, so this
	// goes through db.run() with parameter binding instead of string
	// interpolation to stay injection-safe.
	const inserted = await db.all<{ videoId: string }>(sql`
		INSERT INTO quota_reservations (user_id, job_id, video_id, estimated_bytes)
		SELECT ${userId}, ${jobId}, ${videoId}, ${estimatedBytes}
		WHERE ${usageBytes} + coalesce(
			(SELECT sum(estimated_bytes) FROM quota_reservations WHERE user_id = ${userId}), 0
		) + ${estimatedBytes} <= ${quotaBytes}
		ON CONFLICT (job_id, video_id) DO NOTHING
		RETURNING video_id AS videoId
	`);

	const reserved = inserted.length > 0;
	const currentlyReserved = await getUserReservedBytes(db, userId);
	const remainingBytes = Math.max(0, quotaBytes - usageBytes - currentlyReserved);

	return { reserved, remainingBytes };
}

/**
 * Releases one song's reservation — called once its outcome is known
 * (recorded as a real songs row, or given up on entirely) so the bytes it
 * held stop counting against remaining quota. Idempotent: releasing a
 * reservation that doesn't exist (already released, or never made) is a
 * no-op rather than an error, since the caller (the Durable Object
 * processing a song_success/song_failed event) has no reliable way to
 * know in advance whether this specific event is a first delivery or a
 * retry.
 */
export async function releaseQuotaReservation(
	db: Db,
	jobId: string,
	videoId: string
): Promise<void> {
	await db
		.delete(quotaReservations)
		.where(and(eq(quotaReservations.jobId, jobId), eq(quotaReservations.videoId, videoId)));
}

/** Releases every reservation still held by a job — called when a job reaches any terminal status, so an abandoned reservation from a crashed/cancelled job never lingers. */
export async function releaseAllQuotaReservationsForJob(db: Db, jobId: string): Promise<void> {
	await db.delete(quotaReservations).where(eq(quotaReservations.jobId, jobId));
}
