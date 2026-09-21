import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { importJobs, quotaReservations } from '../db/schema';
import { getUserQuotaBytes, getUserStorageUsageBytes } from '../eviction/usage';

/**
 * How long a job may reuse its cached usage figure before recomputing.
 *
 * Usage can grow without this job's involvement — adding an existing song
 * to a playlist from the UI counts against quota without any reservation —
 * so the cache can drift low, which would let a job over-reserve. Bounding
 * the staleness bounds that drift: at worst a user over-reserves by
 * whatever they added by hand in the last minute, and the next refresh
 * corrects it. A minute is short enough that the error stays small and
 * long enough that a fast import (several songs per second) still gets
 * essentially all of the savings.
 *
 * Quota is not a hard safety boundary here — it's an allowance with an
 * eviction path — so trading an exact-but-expensive figure for a
 * slightly-stale-but-cheap one is the right shape of tradeoff. The one
 * thing that must stay exact is the *reservation* sum, and that still
 * comes straight from the table on every call.
 */
const USAGE_CACHE_TTL_MS = 60_000;

/**
 * The user's storage usage, recomputed at most once per
 * USAGE_CACHE_TTL_MS per job.
 *
 * Without this, reserveQuota recomputed usage for every single song, and
 * each recomputation reads the user's entire library — the dominant source
 * of D1 row reads in the whole application, and quadratic overall, since
 * cost per song grows with the library the import is adding to.
 *
 * Safe to cache only because one user has at most one import in flight
 * (see createImportJob): the job reading this value is the only importer
 * whose reservations are in play, so the sole way the underlying figure
 * moves is a manual library change, which the TTL bounds.
 */
async function getCachedUsageBytes(db: Db, userId: string, jobId: string): Promise<number> {
	const job = await db.query.importJobs.findFirst({
		where: eq(importJobs.id, jobId),
		columns: { cachedUsageBytes: true, cachedUsageAt: true }
	});

	if (job?.cachedUsageBytes != null && job.cachedUsageAt) {
		// cached_usage_at is written by SQLite's own current_timestamp, so it
		// has no zone marker; it is UTC, and Date.parse needs telling.
		const takenAt = Date.parse(job.cachedUsageAt.replace(' ', 'T') + 'Z');
		if (Number.isFinite(takenAt) && Date.now() - takenAt < USAGE_CACHE_TTL_MS) {
			return job.cachedUsageBytes;
		}
	}

	const usageBytes = await getUserStorageUsageBytes(db, userId);
	await db
		.update(importJobs)
		.set({ cachedUsageBytes: usageBytes, cachedUsageAt: sql`(current_timestamp)` })
		.where(eq(importJobs.id, jobId));
	return usageBytes;
}

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
		getCachedUsageBytes(db, userId, jobId)
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
	// Straight from the table, never cached: this is the figure the INSERT
	// above tested against, and the one the caller decides on.
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
