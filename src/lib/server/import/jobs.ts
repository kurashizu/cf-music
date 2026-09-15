import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { importJobs, songs } from '../db/schema';
import { addSongToPlaylist } from '../library/playlists';
import { chunk } from '../../shared/chunk';
import { recordAuditEvent } from '../audit/log';
import { releaseQuotaReservation, releaseAllQuotaReservationsForJob } from './quota-reservations';
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
		public readonly code: 'not_found' | 'invalid_transition'
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

export async function createImportJob(db: Db, input: CreateImportJobInput): Promise<{ id: string }> {
	const id = crypto.randomUUID();
	await db.insert(importJobs).values({
		id,
		userId: input.userId,
		sourceUrl: input.sourceUrl,
		targetPlaylistId: input.targetPlaylistId
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
		.set({ status: 'running', totalCount })
		.where(eq(importJobs.id, jobId));
}

/**
 * Called once CI has resolved the source URL into a concrete list of
 * videos — informational only (lets the UI show what was found). CI sends
 * this immediately followed by a `start` event (see startImportJob), so
 * this deliberately does not touch `status`: there's no confirmation gate
 * to park the job behind anymore, downloading begins right away.
 */
export async function submitImportPreview(db: Db, jobId: string, entries: PreviewEntry[]): Promise<void> {
	await db
		.update(importJobs)
		.set({
			totalCount: entries.length,
			previewEntries: JSON.stringify(entries)
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
		throw new ImportJobError('Job cannot be cancelled from its current status', 'invalid_transition');
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
 * Records one successfully imported song: writes (or reuses, if this
 * video_id was already imported by someone else) the `songs` row, links it
 * into the job's target playlist if one was given, and bumps the job's
 * completed count.
 */
export async function recordSongImported(db: Db, jobId: string, userId: string, song: SongImportSuccess): Promise<void> {
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

	if (job.targetPlaylistId) {
		await addSongToPlaylist(db, job.targetPlaylistId, userId, song.videoId);
	}

	await db
		.update(importJobs)
		.set({ completedCount: sql`${importJobs.completedCount} + 1` })
		.where(eq(importJobs.id, jobId));

	// The song's real size is now committed as actual usage (via the songs
	// row just inserted/reused above) — the reservation that held its
	// estimated size no longer needs to count separately, or it would
	// double-count against quota for as long as the reservation lingered.
	await releaseQuotaReservation(db, jobId, song.videoId);
}

/** Records one song that failed to import (per design: skip and continue, report failures at the end). */
export async function recordSongFailed(db: Db, jobId: string, userId: string, failure: SongImportFailureInput): Promise<void> {
	const job = await getOwnedJob(db, jobId, userId);

	const existingFailures: SongImportFailureInput[] = job.failures ? JSON.parse(job.failures) : [];
	existingFailures.push(failure);

	await db
		.update(importJobs)
		.set({
			failedCount: sql`${importJobs.failedCount} + 1`,
			failures: JSON.stringify(existingFailures)
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
export async function failImportJob(db: Db, jobId: string, userId: string, reason: string): Promise<void> {
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

export async function completeImportJob(db: Db, jobId: string, userId: string): Promise<void> {
	const job = await getOwnedJob(db, jobId, userId);
	// A user-initiated cancellation mid-run races with CI's own "I'm done"
	// call — CI only checks for cancellation between songs, so it can still
	// reach completion after the fact. Cancelled is a terminal status a late
	// completion should never overwrite.
	if (job.status === 'cancelled') return;

	const status = job.failedCount > 0 && job.completedCount === 0 ? 'failed' : 'completed';

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
			failedCount: job.failedCount
		}
	});
}
