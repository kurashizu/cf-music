import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { importJobs, songs } from '../db/schema';
import { addSongToPlaylist } from '../library/playlists';

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

export interface SongImportSuccess {
	videoId: string;
	sourcePlatform: string;
	sourceUrl: string;
	title: string;
	durationSeconds?: number;
	audioKey: string;
	codec: string;
	container: string;
	bitrateKbps?: number;
	sampleRate?: number;
	fileSizeBytes: number;
	coverKey?: string;
	coverWidth?: number;
	coverHeight?: number;
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
			coverHeight: song.coverHeight
		})
		.onConflictDoNothing(); // video_id already imported (by this or another user) — reuse the existing row

	if (job.targetPlaylistId) {
		await addSongToPlaylist(db, job.targetPlaylistId, userId, song.videoId);
	}

	await db
		.update(importJobs)
		.set({ completedCount: sql`${importJobs.completedCount} + 1` })
		.where(eq(importJobs.id, jobId));
}

export interface SongImportFailureInput {
	videoId: string;
	reason: string;
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
}

export async function completeImportJob(db: Db, jobId: string, userId: string): Promise<void> {
	const job = await getOwnedJob(db, jobId, userId);
	const status = job.failedCount > 0 && job.completedCount === 0 ? 'failed' : 'completed';

	await db
		.update(importJobs)
		.set({ status, completedAt: new Date().toISOString() })
		.where(eq(importJobs.id, jobId));
}
