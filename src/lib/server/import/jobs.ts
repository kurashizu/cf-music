import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { importJobs, songs } from '../db/schema';
import { addSongToPlaylist, ensureDefaultPlaylist } from '../library/playlists';
import { chunk } from '../../shared/chunk';
import { recordAuditEvent } from '../audit/log';
import { releaseQuotaReservation, releaseAllQuotaReservationsForJob } from './quota-reservations';
import { enqueueEmbeddingJob } from '../embedding/jobs';
import type {
	PreviewEntry,
	SongImportSuccess,
	SongImportFailureInput
} from '../../shared/import-events';

export type { PreviewEntry, SongImportSuccess, SongImportFailureInput };

// D1 caps bound parameters per statement at 100 (well below plain SQLite's
// own 999 limit) — confirmed by an integration test that failed with
// "too many SQL variables" at a batch size of 500. A playlist import can
// easily exceed 100 video ids, so the IN (...) lookup is split into
// batches safely under the limit.
const KNOWN_VIDEO_IDS_BATCH_SIZE = 90;

/**
 * Given a batch of video ids (e.g. from a playlist about to be imported),
 * returns the subset that already exist in `songs` — so the CI import job
 * can skip re-downloading/re-uploading audio for songs already in the
 * library, and avoid the unique-constraint failure recordSongImported()
 * would otherwise hit on a duplicate videoId.
 */
export async function findKnownVideoIds(db: Db, videoIds: string[]): Promise<string[]> {
	const known: string[] = [];
	for (const batch of chunk(videoIds, KNOWN_VIDEO_IDS_BATCH_SIZE)) {
		const rows = await db
			.select({ videoId: songs.videoId })
			.from(songs)
			.where(inArray(songs.videoId, batch));
		known.push(...rows.map((r) => r.videoId));
	}
	return known;
}

export class ImportJobError extends Error {
	constructor(
		message: string,
		public readonly code: 'not_found' | 'invalid_transition' | 'already_running'
	) {
		super(message);
		this.name = 'ImportJobError';
	}
}

export interface CreateImportJobInput {
	userId: string;
	sourceUrl: string;
	targetPlaylistId?: string;
}

/**
 * The job a user already has in flight, or null. `pending` counts as much
 * as `running` does: a dispatched workflow that hasn't reported progress
 * yet is still going to download songs and still going to claim quota.
 *
 * A job only stays in these two states while it's genuinely live —
 * failStaleImportJobs (above) moves an abandoned one to `failed`, so a
 * crashed CI run can't leave a user permanently unable to import.
 */
export async function findActiveImportJob(db: Db, userId: string) {
	return db.query.importJobs.findFirst({
		where: and(eq(importJobs.userId, userId), inArray(importJobs.status, ['pending', 'running']))
	});
}

/**
 * Creates a job, refusing if this user already has one in flight.
 *
 * One import at a time per user is what makes the whole per-user import
 * path tractable. Without it a user can dispatch unbounded GitHub Actions
 * workflows, and — because each running job claims quota for every song it
 * downloads — two jobs can interleave their reservations against each
 * other's. Holding that to one job means the only writer to a user's
 * quota_reservations rows is the single job that owns them, which is what
 * lets reserveQuota read its usage baseline once per song instead of
 * rescanning the whole library (see quota-reservations.ts).
 *
 * The check and the insert are not a transaction: two simultaneous POSTs
 * could in principle both see no active job. That's deliberate — D1 has no
 * interactive transactions, and the consequence of losing that race is one
 * extra concurrent job, which the quota reservations themselves still
 * account for correctly. The guard exists to stop unbounded dispatch, not
 * to be a mutex.
 */
export async function createImportJob(
	db: Db,
	input: CreateImportJobInput
): Promise<{ id: string }> {
	const active = await findActiveImportJob(db, input.userId);
	if (active) {
		throw new ImportJobError(
			'You already have an import running. Wait for it to finish, or cancel it first.',
			'already_running'
		);
	}

	const id = crypto.randomUUID();
	await db.insert(importJobs).values({
		id,
		userId: input.userId,
		sourceUrl: input.sourceUrl,
		targetPlaylistId: input.targetPlaylistId,
		// updated_at's column default can't be `current_timestamp` — D1
		// rejects a non-constant default on ALTER TABLE ADD COLUMN, unlike
		// plain SQLite (see migrations/0006_nervous_lockheed.sql) — so every
		// insert has to set it explicitly instead of relying on the column
		// default the way created_at does.
		updatedAt: sql`(current_timestamp)`
	});
	return { id };
}

async function getOwnedJob(db: Db, jobId: string, userId: string) {
	const job = await db.query.importJobs.findFirst({ where: eq(importJobs.id, jobId) });
	if (!job || job.userId !== userId) throw new ImportJobError('Import job not found', 'not_found');
	return job;
}

export async function getImportJob(db: Db, jobId: string, userId: string) {
	return getOwnedJob(db, jobId, userId);
}

/**
 * Lists a user's still-relevant import jobs, most recent first — lets the
 * import page restore visibility into what's currently running (or just
 * failed) after a page refresh, since the WebSocket connection alone only
 * carries updates for jobs the client already knows about. completed and
 * cancelled jobs are excluded — those need no further explanation and are
 * recorded to the audit log instead (see completeImportJob/cancelImportJob)
 * rather than accumulating here. failed is deliberately kept: the user
 * needs to actually see why it failed, not just have it vanish.
 */
export async function listImportJobs(db: Db, userId: string) {
	return db.query.importJobs.findMany({
		where: and(
			eq(importJobs.userId, userId),
			inArray(importJobs.status, ['pending', 'running', 'failed'])
		),
		orderBy: (t, { desc }) => desc(t.createdAt),
		limit: 20
	});
}

/**
 * Finds jobs stuck at `pending`/`running` with no progress update in over
 * `staleAfterMs` — the fallback for the zombie case the Durable Object's
 * webSocketClose/webSocketError handler can't see: CI's socket never
 * actually connects at all (workflow_dispatch was accepted but the run
 * never started, or import.py crashed before opening its WebSocket), so
 * there is no close/error event to react to. Nothing else in this codebase
 * ever notices that case on its own. Ideally driven by a scheduled Cron
 * Trigger, but this account's Workers Free plan is already at its 5-cron
 * account-wide cap — so instead it's called via `ctx.waitUntil` from the
 * import page's own `load` (see runImportSweep in
 * src/lib/server/scheduled/import-sweep.ts), which only sweeps when a user
 * actually looks at the page, not on a fixed schedule.
 */
export async function findStaleImportJobs(db: Db, staleAfterMs: number) {
	const staleAfterSeconds = Math.floor(staleAfterMs / 1000);
	// updated_at is stored via SQLite's own `current_timestamp` ("YYYY-MM-DD
	// HH:MM:SS", no "T"/"Z"/milliseconds) — comparing it against a
	// JS-generated `Date.toISOString()` string ("YYYY-MM-DDTHH:MM:SS.sssZ")
	// is wrong: at the 11th character ' ' (0x20) sorts below 'T' (0x54), so
	// every real timestamp reads as "less than" any ISO cutoff regardless of
	// actual date, matching every job instead of just stale ones. Computing
	// the cutoff with SQLite's own datetime() keeps both sides in the same
	// format.
	return db.query.importJobs.findMany({
		where: and(
			inArray(importJobs.status, ['pending', 'running']),
			sql`${importJobs.updatedAt} < datetime('now', ${'-' + staleAfterSeconds + ' seconds'})`
		)
	});
}

/** Runs findStaleImportJobs and fails every match — see findStaleImportJobs for why this exists. */
export async function failStaleImportJobs(db: Db, staleAfterMs: number): Promise<number> {
	const stale = await findStaleImportJobs(db, staleAfterMs);
	for (const job of stale) {
		await failImportJob(
			db,
			job.id,
			job.userId,
			'Import timed out with no progress — the process likely never started or crashed silently'
		);
	}
	return stale.length;
}

/**
 * Fetches a job without an ownership check — for the GitHub Actions webhook
 * callback only, which authenticates via HMAC signature (see
 * webhook-auth.ts) rather than a user session, and needs to first discover
 * which user a job belongs to before it can call the ownership-checked
 * functions below.
 */
export async function getImportJobUnchecked(db: Db, jobId: string) {
	const job = await db.query.importJobs.findFirst({ where: eq(importJobs.id, jobId) });
	if (!job) throw new ImportJobError('Import job not found', 'not_found');
	return job;
}

/** Called once CI has resolved the source URL and knows how many items to expect. */
export async function startImportJob(db: Db, jobId: string, totalCount: number): Promise<void> {
	await db
		.update(importJobs)
		.set({ status: 'running', totalCount, updatedAt: sql`(current_timestamp)` })
		.where(eq(importJobs.id, jobId));
}

/**
 * Called once CI has resolved the source URL into a concrete list of
 * videos — informational only (lets the UI show what was found). CI sends
 * this immediately followed by a `start` event (see startImportJob), so
 * this deliberately does not touch `status`: there's no confirmation gate
 * to park the job behind anymore, downloading begins right away.
 */
export async function submitImportPreview(
	db: Db,
	jobId: string,
	entries: PreviewEntry[],
	truncated = false
): Promise<void> {
	await db
		.update(importJobs)
		.set({
			totalCount: entries.length,
			previewEntries: JSON.stringify(entries),
			truncated,
			updatedAt: sql`(current_timestamp)`
		})
		.where(eq(importJobs.id, jobId));
}

/**
 * User-initiated cancellation of an in-progress import, or dismissal of a
 * failed one — both just mean "stop showing me this job". CI checks for a
 * cancel between songs (see getImportJob polling in the CI script) and
 * stops early rather than continuing to download after the user has
 * backed out; a failed job has nothing left running to stop, so this just
 * clears it from listImportJobs (dismissing it doesn't erase the audit
 * log entry completeImportJob/failImportJob already wrote).
 */
const CANCELLABLE_STATUSES = new Set(['pending', 'running', 'failed']);

/**
 * `pending` is included alongside `running` because a job can get stuck
 * there permanently if the GitHub Actions dispatch itself failed (see
 * dispatchImportWorkflow) — no CI process is ever going to connect and
 * move it forward on its own, so the user must be able to cancel it from
 * here too, not just once CI has picked it up.
 */
export async function cancelImportJob(db: Db, jobId: string, userId: string): Promise<void> {
	const job = await getOwnedJob(db, jobId, userId);
	if (!CANCELLABLE_STATUSES.has(job.status)) {
		throw new ImportJobError(
			'Job cannot be cancelled from its current status',
			'invalid_transition'
		);
	}

	await db.update(importJobs).set({ status: 'cancelled' }).where(eq(importJobs.id, jobId));
	// Whatever this job still had reserved (in-flight downloads CI hasn't
	// reported back on yet) is abandoned along with the job itself.
	await releaseAllQuotaReservationsForJob(db, jobId);

	await recordAuditEvent(db, {
		userId,
		actorId: userId,
		eventType: 'import',
		targetType: 'import_job',
		targetId: jobId,
		detail: { sourceUrl: job.sourceUrl, status: 'cancelled' }
	});
}

/**
 * Every imported song is always linked into the user's default playlist —
 * it's the one place the whole library is guaranteed reachable from (see
 * its own delete/remove protections in library/playlists.ts) — in addition
 * to whatever explicit target playlist the import named, if different.
 */
async function linkImportedSongToLibrary(
	db: Db,
	userId: string,
	targetPlaylistId: string | null,
	videoId: string
): Promise<void> {
	const { id: defaultPlaylistId } = await ensureDefaultPlaylist(db, userId);
	await addSongToPlaylist(db, defaultPlaylistId, userId, videoId);
	if (targetPlaylistId && targetPlaylistId !== defaultPlaylistId) {
		await addSongToPlaylist(db, targetPlaylistId, userId, videoId);
	}
}

/**
 * Records one successfully imported song: writes (or reuses, if this
 * video_id was already imported by someone else) the `songs` row, links it
 * into the user's default playlist and the job's target playlist if
 * different, and bumps the job's completed count.
 */
export async function recordSongImported(
	db: Db,
	jobId: string,
	userId: string,
	song: SongImportSuccess
): Promise<void> {
	const job = await getOwnedJob(db, jobId, userId);

	await db
		.insert(songs)
		.values({
			videoId: song.videoId,
			sourcePlatform: song.sourcePlatform,
			sourceUrl: song.sourceUrl,
			title: song.title,
			durationSeconds: song.durationSeconds,
			audioKey: song.audioKey,
			codec: song.codec,
			container: song.container,
			bitrateKbps: song.bitrateKbps,
			sampleRate: song.sampleRate,
			fileSizeBytes: song.fileSizeBytes,
			coverKey: song.coverKey,
			coverWidth: song.coverWidth,
			coverHeight: song.coverHeight,
			artist: song.artist,
			album: song.album,
			genre: song.genre,
			releaseYear: song.releaseYear,
			tags: song.tags ? JSON.stringify(song.tags) : undefined
		})
		.onConflictDoNothing(); // video_id already imported (by this or another user) — reuse the existing row

	// Queued regardless of whether the insert above actually landed a new
	// row (onConflictDoNothing doesn't report that) — enqueueEmbeddingJob is
	// itself onConflictDoNothing against the same videoId, so this is a
	// no-op for a song that's already queued/embedded from a prior import.
	await enqueueEmbeddingJob(db, song.videoId);

	await linkImportedSongToLibrary(db, userId, job.targetPlaylistId, song.videoId);

	await db
		.update(importJobs)
		.set({
			completedCount: sql`${importJobs.completedCount} + 1`,
			updatedAt: sql`(current_timestamp)`
		})
		.where(eq(importJobs.id, jobId));

	// The song's real size is now committed as actual usage (via the songs
	// row just inserted/reused above) — the reservation that held its
	// estimated size no longer needs to count separately, or it would
	// double-count against quota for as long as the reservation lingered.
	await releaseQuotaReservation(db, jobId, song.videoId);
}

/**
 * Records one song that was already in the library (found via
 * findKnownVideoIds) and so was never downloaded at all — only links it
 * into the job's target playlist and bumps knownCount, no `songs` row
 * write (there's nothing new to write; the existing row is reused as-is).
 * Without this, a known song was skipped by CI's own filtering (so it's
 * correctly never re-downloaded) but then silently never linked into the
 * playlist either — dropped entirely from an import that named it, even
 * though the whole point of "already in the library" is that it's
 * available to reuse, not that it should be excluded from this import's
 * result.
 *
 * knownCount, not completedCount: both mean "this job produced a usable
 * song" toward totalCount, but a skip and a real new download are a
 * meaningfully different outcome to show the user — see the column's own
 * comment in schema.ts.
 */
export async function recordKnownSongLinked(
	db: Db,
	jobId: string,
	userId: string,
	videoId: string
): Promise<void> {
	const job = await getOwnedJob(db, jobId, userId);

	await linkImportedSongToLibrary(db, userId, job.targetPlaylistId, videoId);

	await db
		.update(importJobs)
		.set({ knownCount: sql`${importJobs.knownCount} + 1`, updatedAt: sql`(current_timestamp)` })
		.where(eq(importJobs.id, jobId));
}

/** Records one song that failed to import (per design: skip and continue, report failures at the end). */
export async function recordSongFailed(
	db: Db,
	jobId: string,
	userId: string,
	failure: SongImportFailureInput
): Promise<void> {
	const job = await getOwnedJob(db, jobId, userId);

	const existingFailures: SongImportFailureInput[] = job.failures ? JSON.parse(job.failures) : [];
	existingFailures.push(failure);

	await db
		.update(importJobs)
		.set({
			failedCount: sql`${importJobs.failedCount} + 1`,
			failures: JSON.stringify(existingFailures),
			updatedAt: sql`(current_timestamp)`
		})
		.where(eq(importJobs.id, jobId));

	// This song never became real usage — release the bytes it held so a
	// later song in the same (or a different) job can use them.
	await releaseQuotaReservation(db, jobId, failure.videoId);
}

/**
 * CI hit an unrecoverable error before/outside the per-song loop (source
 * extraction failed entirely, the WARP proxy never came up, etc.) — marks
 * the job failed outright rather than leaving it stuck at its prior status
 * forever, which is what happened before this existed: the CI process just
 * exits non-zero and drops the WebSocket with no way to say why.
 */
export async function failImportJob(
	db: Db,
	jobId: string,
	userId: string,
	reason: string
): Promise<void> {
	const job = await getOwnedJob(db, jobId, userId);
	// A late fatal_error/close can race with CI's own successful completion
	// or a user's cancellation reaching D1 first — once a job has already
	// reached any terminal status, that status wins; this should never
	// resurrect a completed/cancelled job as failed.
	if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') return;

	const truncatedReason = reason.slice(0, 500);

	await db
		.update(importJobs)
		.set({ status: 'failed', fatalError: truncatedReason, completedAt: new Date().toISOString() })
		.where(eq(importJobs.id, jobId));
	// Covers both a normal fatal error and the Durable Object's zombie-job
	// auto-fail (an unexpected CI disconnect) — either way, whatever this
	// job still had reserved is abandoned along with it.
	await releaseAllQuotaReservationsForJob(db, jobId);

	await recordAuditEvent(db, {
		userId,
		actorId: userId,
		eventType: 'import',
		targetType: 'import_job',
		targetId: jobId,
		detail: { sourceUrl: job.sourceUrl, status: 'failed', reason: truncatedReason }
	});
}

/**
 * Called when the CI process's WebSocket disconnects unexpectedly (see
 * handlePossibleZombieJob) — distinct from failImportJob because an
 * unexpected disconnect after real progress isn't the same situation as
 * one before any song ever succeeded. Mirrors completeImportJob's own
 * status rule: some songs already landed (completedCount + knownCount > 0)
 * means the user gets to keep that partial result marked `completed`, the
 * same as if CI had sent its own `complete` event right then — only a
 * disconnect with nothing to show for it is a real `failed`. Without this
 * distinction, a 12-song batch that fully succeeded before CI's process
 * happened to drop the connection on its way to sending `complete` showed
 * up as an outright failure, even though every song the user asked for
 * was sitting in their library already. knownCount counts here too: a
 * batch that was 100% already-owned songs (nothing to download, only
 * links to write) is just as much a real result as one CI downloaded
 * itself.
 */
export async function disconnectImportJob(
	db: Db,
	jobId: string,
	userId: string,
	reason: string
): Promise<void> {
	const job = await getOwnedJob(db, jobId, userId);
	if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') return;

	if (job.completedCount + job.knownCount > 0) {
		await completeImportJob(db, jobId, userId);
		return;
	}

	await failImportJob(db, jobId, userId, reason);
}

export async function completeImportJob(db: Db, jobId: string, userId: string): Promise<void> {
	const job = await getOwnedJob(db, jobId, userId);
	// A user-initiated cancellation mid-run races with CI's own "I'm done"
	// call — CI only checks for cancellation between songs, so it can still
	// reach completion after the fact. Cancelled is a terminal status a late
	// completion should never overwrite.
	if (job.status === 'cancelled') return;

	// knownCount counts as "produced a usable song" the same as
	// completedCount (see recordKnownSongLinked) — a batch that was 100%
	// already-owned songs, with zero new downloads and zero failures,
	// should read as `completed`, not `failed` for having completedCount
	// === 0.
	const status =
		job.failedCount > 0 && job.completedCount + job.knownCount === 0 ? 'failed' : 'completed';

	await db
		.update(importJobs)
		.set({ status, completedAt: new Date().toISOString() })
		.where(eq(importJobs.id, jobId));
	// Every song's reservation should already be gone by now (released in
	// recordSongImported/recordSongFailed as each one resolved) — this is
	// defense-in-depth against a reservation somehow surviving to here
	// (e.g. an event that got dropped), not the primary release path.
	await releaseAllQuotaReservationsForJob(db, jobId);

	await recordAuditEvent(db, {
		userId,
		actorId: userId,
		eventType: 'import',
		targetType: 'import_job',
		targetId: jobId,
		detail: {
			sourceUrl: job.sourceUrl,
			status,
			completedCount: job.completedCount,
			knownCount: job.knownCount,
			failedCount: job.failedCount
		}
	});
}
