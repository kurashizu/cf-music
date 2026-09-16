import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { users, songs, playlists, importJobs, embeddingJobs, tagVectors } from '../db/schema';
import { createImportJob, recordSongImported, type SongImportSuccess } from '../import/jobs';
import { claimAutoTagCandidates, getAllTagVectors, writeAutoTags } from './jobs';

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

/** Seeds a real songs row (with its auto-created embedding_jobs row) and sets that job's status directly, to control the claim query's join condition per test. */
async function seedSongWithEmbeddingStatus(videoId: string, status: 'pending' | 'processing' | 'done' | 'failed') {
	await seedUser('u1');
	const { id: jobId } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
	await recordSongImported(db, jobId, 'u1', makeSong(videoId));
	await db.update(embeddingJobs).set({ status }).where(eq(embeddingJobs.videoId, videoId));
}

beforeEach(async () => {
	await db.update(users).set({ defaultPlaylistId: null });
	await db.delete(embeddingJobs);
	await db.delete(playlists);
	await db.delete(importJobs);
	await db.delete(songs);
	await db.delete(users);
	await db.delete(tagVectors);
});

describe('claimAutoTagCandidates', () => {
	it('claims a song whose embedding job is done and whose autoTags is null', async () => {
		await seedSongWithEmbeddingStatus('a', 'done');

		const videoIds = await claimAutoTagCandidates(db);

		expect(videoIds).toEqual(['a']);
	});

	it('does not claim a song whose embedding job is still pending', async () => {
		await seedSongWithEmbeddingStatus('a', 'pending');

		const videoIds = await claimAutoTagCandidates(db);

		expect(videoIds).toEqual([]);
	});

	it('does not claim a song whose embedding job failed', async () => {
		await seedSongWithEmbeddingStatus('a', 'failed');

		const videoIds = await claimAutoTagCandidates(db);

		expect(videoIds).toEqual([]);
	});

	it('does not claim a song that already has autoTags set', async () => {
		await seedSongWithEmbeddingStatus('a', 'done');
		await db.update(songs).set({ autoTags: '{"jazz":0.5}' }).where(eq(songs.videoId, 'a'));

		const videoIds = await claimAutoTagCandidates(db);

		expect(videoIds).toEqual([]);
	});

	it('claims every eligible song, not just one', async () => {
		await seedSongWithEmbeddingStatus('a', 'done');
		await seedSongWithEmbeddingStatus('b', 'done');
		await seedSongWithEmbeddingStatus('c', 'pending');

		const videoIds = await claimAutoTagCandidates(db);

		expect(videoIds.sort()).toEqual(['a', 'b']);
	});
});

describe('getAllTagVectors', () => {
	it('returns every tag with its embedding parsed back into a number array', async () => {
		await db.insert(tagVectors).values([
			{ tag: 'jazz', facet: 'genre', embedding: JSON.stringify([0.1, 0.2, 0.3]) },
			{ tag: 'chill', facet: 'mood', embedding: JSON.stringify([0.4, 0.5, 0.6]) }
		]);

		const vectors = await getAllTagVectors(db);

		expect(vectors.sort((a, b) => a.tag.localeCompare(b.tag))).toEqual([
			{ tag: 'chill', embedding: [0.4, 0.5, 0.6] },
			{ tag: 'jazz', embedding: [0.1, 0.2, 0.3] }
		]);
	});

	it('returns an empty array when tag_vectors has never been seeded', async () => {
		const vectors = await getAllTagVectors(db);
		expect(vectors).toEqual([]);
	});
});

describe('writeAutoTags', () => {
	it('writes the similarity scores as JSON to the matching song', async () => {
		await seedSongWithEmbeddingStatus('a', 'done');

		await writeAutoTags(db, [{ videoId: 'a', autoTags: { jazz: 0.42, chill: 0.61 } }]);

		const song = await db.query.songs.findFirst({ where: eq(songs.videoId, 'a') });
		expect(JSON.parse(song!.autoTags!)).toEqual({ jazz: 0.42, chill: 0.61 });
	});

	it('writes multiple songs in one call independently', async () => {
		await seedSongWithEmbeddingStatus('a', 'done');
		await seedSongWithEmbeddingStatus('b', 'done');

		await writeAutoTags(db, [
			{ videoId: 'a', autoTags: { jazz: 0.9 } },
			{ videoId: 'b', autoTags: { jazz: 0.1 } }
		]);

		const songA = await db.query.songs.findFirst({ where: eq(songs.videoId, 'a') });
		const songB = await db.query.songs.findFirst({ where: eq(songs.videoId, 'b') });
		expect(JSON.parse(songA!.autoTags!)).toEqual({ jazz: 0.9 });
		expect(JSON.parse(songB!.autoTags!)).toEqual({ jazz: 0.1 });
	});

	it('does not throw when a videoId no longer exists (song deleted between claim and complete)', async () => {
		await expect(writeAutoTags(db, [{ videoId: 'deleted-song', autoTags: { jazz: 0.5 } }])).resolves.not.toThrow();
	});

	it('a song claimed once (autoTags now non-null) is no longer claimed on the next run', async () => {
		await seedSongWithEmbeddingStatus('a', 'done');
		await writeAutoTags(db, [{ videoId: 'a', autoTags: { jazz: 0.5 } }]);

		const videoIds = await claimAutoTagCandidates(db);

		expect(videoIds).toEqual([]);
	});
});
