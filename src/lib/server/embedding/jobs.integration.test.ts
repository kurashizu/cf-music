import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { users, songs, playlists, importJobs, embeddingJobs } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import {
	claimEmbeddingJobs,
	markEmbeddingJobDone,
	failEmbeddingJob,
	enqueueEmbeddingJob,
	enqueueMissingEmbeddingJobs,
	getSongsForEmbeddingJobs
} from './jobs';
import { createImportJob, recordSongImported, type SongImportSuccess } from '../import/jobs';

const db = getDb(env.DB);

async function seedUser(id: string) {
	await db
		.insert(users)
		.values({ id, username: `user-${id}`, passwordHash: 'x' })
		.onConflictDoNothing();
}

function makeSong(videoId: string, overrides: Partial<SongImportSuccess> = {}): SongImportSuccess {
	return {
		videoId,
		sourcePlatform: 'youtube',
		sourceUrl: `https://youtube.com/watch?v=${videoId}`,
		title: `Song ${videoId}`,
		audioKey: `audio/${videoId}.webm`,
		codec: 'opus',
		container: 'webm',
		fileSizeBytes: 100_000,
		...overrides
	};
}

/** Seeds a real `songs` row via the same import path production uses, without an embedding job — recordSongImported auto-enqueues one, so this deletes it right back out to simulate a pre-feature song. */
async function seedSongWithoutEmbeddingJob(videoId: string) {
	await seedUser('u1');
	// Reuses the user's existing job if there is one: a user may only have
	// one import in flight (see createImportJob), and seeding several songs
	// for one user is exactly the "many songs, one import" case anyway.
	const existing = await db.query.importJobs.findFirst({ where: eq(importJobs.userId, 'u1') });
	const jobId =
		existing?.id ?? (await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' })).id;
	await recordSongImported(db, jobId, 'u1', makeSong(videoId));
	await db.delete(embeddingJobs).where(eq(embeddingJobs.videoId, videoId));
}

beforeEach(async () => {
	await db.update(users).set({ defaultPlaylistId: null });
	await db.delete(embeddingJobs);
	await db.delete(importJobs);
	await db.delete(playlists);
	await db.delete(songs);
	await db.delete(users);
});

describe('enqueueEmbeddingJob', () => {
	it('creates a pending job for a song', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await enqueueEmbeddingJob(db, 'a');

		const job = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.videoId, 'a') });
		expect(job?.status).toBe('pending');
		expect(job?.attempts).toBe(0);
	});

	it('is a no-op if a job already exists for that video', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await enqueueEmbeddingJob(db, 'a');
		await db.update(embeddingJobs).set({ status: 'done' }).where(eq(embeddingJobs.videoId, 'a'));

		await enqueueEmbeddingJob(db, 'a');

		const job = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.videoId, 'a') });
		expect(job?.status).toBe('done');
	});
});

describe('recordSongImported', () => {
	it('auto-enqueues an embedding job when a new song lands', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await recordSongImported(db, id, 'u1', makeSong('a'));

		const job = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.videoId, 'a') });
		expect(job?.status).toBe('pending');
	});
});

describe('claimEmbeddingJobs', () => {
	it('claims pending jobs, flips them to processing, and returns them oldest-first', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await seedSongWithoutEmbeddingJob('b');
		await enqueueEmbeddingJob(db, 'a');
		await enqueueEmbeddingJob(db, 'b');

		const claimed = await claimEmbeddingJobs(db, 10);

		expect(claimed.map((c) => c.videoId).sort()).toEqual(['a', 'b']);
		const rows = await db.query.embeddingJobs.findMany();
		expect(rows.every((r) => r.status === 'processing')).toBe(true);
	});

	it('respects the limit', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await seedSongWithoutEmbeddingJob('b');
		await enqueueEmbeddingJob(db, 'a');
		await enqueueEmbeddingJob(db, 'b');

		const claimed = await claimEmbeddingJobs(db, 1);

		expect(claimed.length).toBe(1);
	});

	it('reclaims jobs stuck at processing past the stale threshold', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await enqueueEmbeddingJob(db, 'a');
		await db
			.update(embeddingJobs)
			.set({ status: 'processing' })
			.where(eq(embeddingJobs.videoId, 'a'));
		// Backdate updatedAt well past STALE_PROCESSING_MS (1 hour) using
		// SQLite's own datetime(), matching the format claimEmbeddingJobs
		// compares against (see findStaleImportJobs' own comment on why a
		// JS-generated ISO string would sort wrong here).
		await db.all(
			sql`UPDATE embedding_jobs SET updated_at = datetime('now', '-2 hours') WHERE video_id = 'a'`
		);

		const claimed = await claimEmbeddingJobs(db, 10);

		expect(claimed.map((c) => c.videoId)).toEqual(['a']);
	});

	it('does not reclaim a processing job that is not yet stale', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await enqueueEmbeddingJob(db, 'a');
		await db
			.update(embeddingJobs)
			.set({ status: 'processing' })
			.where(eq(embeddingJobs.videoId, 'a'));

		const claimed = await claimEmbeddingJobs(db, 10);

		expect(claimed).toEqual([]);
	});

	it('claims a batch larger than the D1 bound-parameter chunk size', async () => {
		const videoIds = Array.from({ length: 200 }, (_, i) => `v${i}`);
		for (const videoId of videoIds) {
			await seedSongWithoutEmbeddingJob(videoId);
			await enqueueEmbeddingJob(db, videoId);
		}

		const claimed = await claimEmbeddingJobs(db, 200);

		expect(claimed.length).toBe(200);
		const rows = await db.query.embeddingJobs.findMany();
		expect(rows.every((r) => r.status === 'processing')).toBe(true);
	});
});

describe('markEmbeddingJobDone', () => {
	it('marks the job done and clears any prior error', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await enqueueEmbeddingJob(db, 'a');
		await db
			.update(embeddingJobs)
			.set({ lastError: 'previous failure' })
			.where(eq(embeddingJobs.videoId, 'a'));

		const [job] = await claimEmbeddingJobs(db, 10);
		await markEmbeddingJobDone(db, job.id);

		const row = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.videoId, 'a') });
		expect(row?.status).toBe('done');
		expect(row?.lastError).toBeNull();
	});
});

describe('failEmbeddingJob', () => {
	it('sends a retryable failure back to pending and increments attempts', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await enqueueEmbeddingJob(db, 'a');
		const [job] = await claimEmbeddingJobs(db, 10);

		await failEmbeddingJob(db, { jobId: job.id, error: 'rate limited', retryable: true });

		const row = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.videoId, 'a') });
		expect(row?.status).toBe('pending');
		expect(row?.attempts).toBe(1);
		expect(row?.lastError).toBe('rate limited');
	});

	it('fails a non-retryable error outright, regardless of attempts remaining', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await enqueueEmbeddingJob(db, 'a');
		const [job] = await claimEmbeddingJobs(db, 10);

		await failEmbeddingJob(db, { jobId: job.id, error: 'corrupt audio', retryable: false });

		const row = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.videoId, 'a') });
		expect(row?.status).toBe('failed');
	});

	it('fails a retryable error outright once attempts are exhausted', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await enqueueEmbeddingJob(db, 'a');
		await db.update(embeddingJobs).set({ attempts: 9 }).where(eq(embeddingJobs.videoId, 'a'));
		const [job] = await claimEmbeddingJobs(db, 10);

		await failEmbeddingJob(db, { jobId: job.id, error: 'still failing', retryable: true });

		const row = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.videoId, 'a') });
		expect(row?.status).toBe('failed');
		expect(row?.attempts).toBe(10);
	});

	it('is a no-op for an unknown job id', async () => {
		await expect(
			failEmbeddingJob(db, { jobId: 'missing', error: 'x', retryable: true })
		).resolves.not.toThrow();
	});
});

describe('getSongsForEmbeddingJobs', () => {
	it('returns an empty array for an empty input', async () => {
		expect(await getSongsForEmbeddingJobs(db, [])).toEqual([]);
	});

	it('returns the songs rows for the given video ids', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await seedSongWithoutEmbeddingJob('b');

		const result = await getSongsForEmbeddingJobs(db, ['a', 'b', 'missing']);

		expect(result.map((s) => s.videoId).sort()).toEqual(['a', 'b']);
	});

	it('handles a batch larger than the D1 bound-parameter chunk size', async () => {
		const videoIds = Array.from({ length: 200 }, (_, i) => `v${i}`);
		for (const videoId of videoIds) {
			await seedSongWithoutEmbeddingJob(videoId);
		}

		const result = await getSongsForEmbeddingJobs(db, videoIds);

		expect(result.length).toBe(200);
	});
});

describe('enqueueMissingEmbeddingJobs', () => {
	it('queues every song with no embedding job at all', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await seedSongWithoutEmbeddingJob('b');

		const count = await enqueueMissingEmbeddingJobs(db);

		expect(count).toBe(2);
		const rows = await db.query.embeddingJobs.findMany();
		expect(rows.map((r) => r.videoId).sort()).toEqual(['a', 'b']);
		expect(rows.every((r) => r.status === 'pending')).toBe(true);
	});

	it('leaves songs that already have a job (in any status) untouched', async () => {
		await seedSongWithoutEmbeddingJob('a');
		await enqueueEmbeddingJob(db, 'a');
		await db.update(embeddingJobs).set({ status: 'failed' }).where(eq(embeddingJobs.videoId, 'a'));

		const count = await enqueueMissingEmbeddingJobs(db);

		expect(count).toBe(0);
		const row = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.videoId, 'a') });
		expect(row?.status).toBe('failed');
	});

	it('is a no-op when there is nothing missing', async () => {
		expect(await enqueueMissingEmbeddingJobs(db)).toBe(0);
	});

	// Regression test: a naive multi-row insert with one batch per song
	// binds 4 params/row (id, video_id, status, attempts) — reusing
	// import/jobs.ts's 90-row IN(...) batch size here (a 1-param-per-row
	// query) would silently exceed D1's ~100 bound-parameter cap per
	// statement. This seeds more than one insert chunk's worth of songs to
	// make sure that never regresses.
	it('handles a batch larger than one insert chunk without hitting the D1 bound-parameter limit', async () => {
		const videoIds = Array.from({ length: 45 }, (_, i) => `bulk-${i}`);
		for (const videoId of videoIds) {
			await seedSongWithoutEmbeddingJob(videoId);
		}

		const count = await enqueueMissingEmbeddingJobs(db);

		expect(count).toBe(videoIds.length);
		const rows = await db.query.embeddingJobs.findMany();
		expect(rows.length).toBe(videoIds.length);
	});
});
