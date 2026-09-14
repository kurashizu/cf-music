import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { users, songs, playlists, importJobs } from '../db/schema';
import { eq } from 'drizzle-orm';
import {
	createImportJob,
	getImportJob,
	startImportJob,
	recordSongImported,
	recordSongFailed,
	completeImportJob,
	ImportJobError,
	type SongImportSuccess
} from './jobs';
import { getPlaylistWithSongs } from '../library/playlists';

const db = getDb(env.DB);

async function seedUser(id: string) {
	await db.insert(users).values({ id, username: `user-${id}`, passwordHash: 'x' }).onConflictDoNothing();
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

beforeEach(async () => {
	await db.delete(importJobs);
	await db.delete(playlists);
	await db.delete(songs);
	await db.delete(users);
});

describe('createImportJob / getImportJob', () => {
	it('creates a job in pending status', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://youtube.com/playlist?list=x' });

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('pending');
		expect(job.completedCount).toBe(0);
		expect(job.failedCount).toBe(0);
	});

	it('throws not_found for a job belonging to a different user', async () => {
		await seedUser('u1');
		await seedUser('u2');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await expect(getImportJob(db, id, 'u2')).rejects.toThrow(ImportJobError);
	});
});

describe('startImportJob', () => {
	it('transitions to running and records the expected total', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await startImportJob(db, id, 5);

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('running');
		expect(job.totalCount).toBe(5);
	});
});

describe('recordSongImported', () => {
	it('creates the song row and increments completedCount', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await recordSongImported(db, id, 'u1', makeSong('a'));

		const job = await getImportJob(db, id, 'u1');
		expect(job.completedCount).toBe(1);
		const song = await db.query.songs.findFirst({ where: eq(songs.videoId, 'a') });
		expect(song).not.toBeUndefined();
	});

	it('links the song into the target playlist when the job has one', async () => {
		await seedUser('u1');
		await db.insert(playlists).values({ id: 'p1', userId: 'u1', name: 'Imported' });
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x', targetPlaylistId: 'p1' });

		await recordSongImported(db, id, 'u1', makeSong('a'));

		const playlist = await getPlaylistWithSongs(db, 'p1', 'u1');
		expect(playlist.songs.map((s) => s.videoId)).toEqual(['a']);
	});

	it('does not fail when the video_id was already imported by someone else (dedup reuse)', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await db.insert(songs).values(makeSong('shared'));
		const { id } = await createImportJob(db, { userId: 'u2', sourceUrl: 'https://x' });

		await expect(recordSongImported(db, id, 'u2', makeSong('shared', { title: 'Different title' }))).resolves.not.toThrow();

		// The pre-existing row's data is preserved, not overwritten by the duplicate import.
		const song = await db.query.songs.findFirst({ where: eq(songs.videoId, 'shared') });
		expect(song?.title).toBe('Song shared');
	});

	it('throws not_found for a job belonging to a different user', async () => {
		await seedUser('u1');
		await seedUser('u2');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await expect(recordSongImported(db, id, 'u2', makeSong('a'))).rejects.toThrow(ImportJobError);
	});
});

describe('recordSongFailed', () => {
	it('increments failedCount and appends to the failures list', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await recordSongFailed(db, id, 'u1', { videoId: 'bad1', reason: 'video unavailable' });
		await recordSongFailed(db, id, 'u1', { videoId: 'bad2', reason: 'no audio track' });

		const job = await getImportJob(db, id, 'u1');
		expect(job.failedCount).toBe(2);
		expect(JSON.parse(job.failures!)).toEqual([
			{ videoId: 'bad1', reason: 'video unavailable' },
			{ videoId: 'bad2', reason: 'no audio track' }
		]);
	});
});

describe('completeImportJob', () => {
	it('marks the job completed when at least one song succeeded, even with some failures', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordSongImported(db, id, 'u1', makeSong('a'));
		await recordSongFailed(db, id, 'u1', { videoId: 'bad', reason: 'error' });

		await completeImportJob(db, id, 'u1');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('completed');
		expect(job.completedAt).not.toBeNull();
	});

	it('marks the job failed when every song failed and none succeeded', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordSongFailed(db, id, 'u1', { videoId: 'bad', reason: 'error' });

		await completeImportJob(db, id, 'u1');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('failed');
	});

	it('marks the job completed when everything succeeded with zero failures', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordSongImported(db, id, 'u1', makeSong('a'));

		await completeImportJob(db, id, 'u1');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('completed');
	});
});
