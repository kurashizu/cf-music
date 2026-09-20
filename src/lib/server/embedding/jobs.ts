import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { embeddingJobs, songs } from '../db/schema';
import { chunk } from '../../shared/chunk';

// D1 caps bound parameters per statement at ~100 (see findKnownVideoIds in
// import/jobs.ts for the same limit). That constant's batch size of 90 is
// NOT reusable here: it was calibrated for a 1-param-per-row IN (...)
// clause, but each row inserted below binds 4 params (id, video_id, status,
// attempts), so a 90-row batch would need ~360 params — comfortably over
// the limit. 20 rows × 4 params = 80, safely under it.
const MISSING_JOBS_INSERT_BATCH_SIZE = 20;

// Same D1 ~100-bound-parameter cap as above, but these queries only bind 1
// param per row (id/videoId), so a much larger batch than the insert above
// still fits comfortably under the limit.
const SINGLE_PARAM_BATCH_SIZE = 90;

// Non-retryable failures (bad/corrupt audio, unsupported format, model
// rejected the input) go straight to 'failed'. Retryable ones (rate limit,
// embedding service unavailable) are put back to 'pending' instead — see
// schema.ts's comment on embeddingJobs for why there's no in-run backoff.
const MAX_ATTEMPTS = 10;

export interface ClaimedEmbeddingJob {
	id: string;
	videoId: string;
	attempts: number;
}

// A claimed job that never reports back (CI runner crashed, workflow was
// cancelled, the job step timed out) would otherwise sit at 'processing'
// forever — nothing else in this table's lifecycle ever revisits it. Chosen
// well under the cron interval (6 hours) so a stuck job is reclaimed by the
// very next run rather than blocking on it indefinitely.
const STALE_PROCESSING_MS = 60 * 60 * 1000;

/**
 * Atomically claims up to `limit` pending jobs (or jobs stuck at
 * 'processing' from a run that crashed/timed out without reporting back —
 * see STALE_PROCESSING_MS) by flipping them to 'processing' and returning
 * the claimed rows in one round trip, so two overlapping workflow runs (a
 * scheduled run still going when a manual workflow_dispatch test run starts)
 * can't both pick up the same job.
 */
export async function claimEmbeddingJobs(db: Db, limit: number): Promise<ClaimedEmbeddingJob[]> {
	const staleAfterSeconds = Math.floor(STALE_PROCESSING_MS / 1000);
	const candidates = await db.query.embeddingJobs.findMany({
		where: (t, { or, and, eq, lt, sql }) =>
			or(
				eq(t.status, 'pending'),
				and(
					eq(t.status, 'processing'),
					sql`${t.updatedAt} < datetime('now', ${'-' + staleAfterSeconds + ' seconds'})`
				)
			),
		orderBy: (t, { asc }) => asc(t.createdAt),
		limit
	});
	if (candidates.length === 0) return [];

	const ids = candidates.map((c) => c.id);
	for (const batch of chunk(ids, SINGLE_PARAM_BATCH_SIZE)) {
		await db
			.update(embeddingJobs)
			.set({ status: 'processing', updatedAt: sql`(current_timestamp)` })
			.where(inArray(embeddingJobs.id, batch));
	}

	return candidates.map((c) => ({ id: c.id, videoId: c.videoId, attempts: c.attempts }));
}

export async function markEmbeddingJobDone(db: Db, jobId: string): Promise<void> {
	await db
		.update(embeddingJobs)
		.set({ status: 'done', lastError: null, updatedAt: sql`(current_timestamp)` })
		.where(eq(embeddingJobs.id, jobId));
}

export interface FailEmbeddingJobInput {
	jobId: string;
	error: string;
	/** True for rate-limit/service-unavailable errors — see MAX_ATTEMPTS. */
	retryable: boolean;
}

/**
 * Records a failed attempt. Retryable errors go back to 'pending' (picked
 * up by the next scheduled run) unless attempts have run out, in which case
 * they're failed outright rather than retried forever against a service
 * that may just be down for good. Non-retryable errors always go straight
 * to 'failed'.
 */
export async function failEmbeddingJob(db: Db, input: FailEmbeddingJobInput): Promise<void> {
	const job = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.id, input.jobId) });
	if (!job) return;

	const attempts = job.attempts + 1;
	const truncatedError = input.error.slice(0, 500);
	const status = input.retryable && attempts < MAX_ATTEMPTS ? 'pending' : 'failed';

	await db
		.update(embeddingJobs)
		.set({ status, attempts, lastError: truncatedError, updatedAt: sql`(current_timestamp)` })
		.where(eq(embeddingJobs.id, input.jobId));
}

/**
 * Queues a new song for embedding — called once from recordSongImported
 * right after a song lands in `songs` for the first time. onConflictDoNothing
 * because a song can already have a row here (re-imported by a second user
 * after onConflictDoNothing reused the existing `songs` row — see
 * recordSongImported), in which case its existing embedding job (whatever
 * state it's in) should be left alone rather than reset to pending.
 */
export async function enqueueEmbeddingJob(db: Db, videoId: string): Promise<void> {
	await db.insert(embeddingJobs).values({ videoId }).onConflictDoNothing();
}

/** Lists videoIds for a batch of claimed jobs, joined with their songs row — the audio key CI needs to fetch each one. */
export async function getSongsForEmbeddingJobs(db: Db, videoIds: string[]) {
	if (videoIds.length === 0) return [];
	const batches = await Promise.all(
		chunk(videoIds, SINGLE_PARAM_BATCH_SIZE).map((batch) =>
			db.query.songs.findMany({ where: inArray(songs.videoId, batch) })
		)
	);
	return batches.flat();
}

/**
 * Queues every song missing an embedding job at all — covers songs imported
 * before this feature existed (a one-time backfill) as well as any that
 * somehow never got enqueued. Safe to run repeatedly: already-queued songs
 * (in any status) are left untouched, since each insert below is
 * onConflictDoNothing against the same unique videoId constraint
 * enqueueEmbeddingJob relies on.
 */
export async function enqueueMissingEmbeddingJobs(db: Db): Promise<number> {
	const missing = await db.all<{ videoId: string }>(sql`
		SELECT s.video_id AS videoId
		FROM songs s
		LEFT JOIN embedding_jobs ej ON ej.video_id = s.video_id
		WHERE ej.video_id IS NULL
	`);
	if (missing.length === 0) return 0;

	for (const batch of chunk(missing, MISSING_JOBS_INSERT_BATCH_SIZE)) {
		await db
			.insert(embeddingJobs)
			.values(batch.map((row) => ({ videoId: row.videoId })))
			.onConflictDoNothing();
	}
	return missing.length;
}
