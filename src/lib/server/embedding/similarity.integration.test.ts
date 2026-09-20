import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { users, songs, playlists, playlistSongs, songEmbeddings } from '../db/schema';
import { getSimilarSongsInLibrary } from './similarity';
import { encodeVector } from './vector-codec';

const db = getDb(env.DB);

async function seedUser(id: string) {
	await db
		.insert(users)
		.values({ id, username: `user-${id}`, passwordHash: 'x' })
		.onConflictDoNothing();
}

async function seedSong(videoId: string) {
	await db
		.insert(songs)
		.values({
			videoId,
			sourcePlatform: 'youtube',
			sourceUrl: `https://youtube.com/watch?v=${videoId}`,
			title: `Song ${videoId}`,
			audioKey: `audio/${videoId}.webm`,
			codec: 'opus',
			container: 'webm',
			fileSizeBytes: 1000
		})
		.onConflictDoNothing();
}

async function addToLibrary(userId: string, videoId: string) {
	const [playlist] = await db.insert(playlists).values({ userId, name: 'Lib' }).returning();
	await db.insert(playlistSongs).values({ playlistId: playlist.id, videoId, position: 0 });
}

async function seedEmbedding(videoId: string, vector: number[]) {
	await db.insert(songEmbeddings).values({ videoId, vector: Buffer.from(encodeVector(vector)) });
}

beforeEach(async () => {
	await db.update(users).set({ defaultPlaylistId: null });
	await db.delete(songEmbeddings);
	await db.delete(playlistSongs);
	await db.delete(playlists);
	await db.delete(songs);
	await db.delete(users);
});

describe('getSimilarSongsInLibrary', () => {
	it('ranks the library by cosine similarity to the seed song, closest first', async () => {
		await seedUser('u1');
		for (const id of ['seed', 'close', 'far', 'opposite']) await seedSong(id);
		for (const id of ['seed', 'close', 'far', 'opposite']) await addToLibrary('u1', id);

		await seedEmbedding('seed', [1, 0]);
		await seedEmbedding('close', [0.9, 0.1]);
		await seedEmbedding('far', [0.1, 0.9]);
		await seedEmbedding('opposite', [-1, 0]);

		const result = await getSimilarSongsInLibrary(db, 'u1', 'seed', 10);

		expect(result.map((s) => s.videoId)).toEqual(['close', 'far', 'opposite']);
	});

	it('excludes the seed song itself from the results', async () => {
		await seedUser('u1');
		await seedSong('seed');
		await addToLibrary('u1', 'seed');
		await seedEmbedding('seed', [1, 0]);

		const result = await getSimilarSongsInLibrary(db, 'u1', 'seed', 10);

		expect(result).toEqual([]);
	});

	it('respects the limit', async () => {
		await seedUser('u1');
		await seedSong('seed');
		await addToLibrary('u1', 'seed');
		await seedEmbedding('seed', [1, 0]);
		for (const id of ['a', 'b', 'c']) {
			await seedSong(id);
			await addToLibrary('u1', id);
			await seedEmbedding(id, [Math.random(), Math.random()]);
		}

		const result = await getSimilarSongsInLibrary(db, 'u1', 'seed', 2);

		expect(result.length).toBe(2);
	});

	it("excludes songs from another user's library", async () => {
		await seedUser('u1');
		await seedUser('u2');
		await seedSong('seed');
		await seedSong('other');
		await addToLibrary('u1', 'seed');
		await addToLibrary('u2', 'other');
		await seedEmbedding('seed', [1, 0]);
		await seedEmbedding('other', [0.9, 0.1]);

		const result = await getSimilarSongsInLibrary(db, 'u1', 'seed', 10);

		expect(result).toEqual([]);
	});

	it('excludes library songs that have no embedding yet', async () => {
		await seedUser('u1');
		await seedSong('seed');
		await seedSong('no-embedding');
		await addToLibrary('u1', 'seed');
		await addToLibrary('u1', 'no-embedding');
		await seedEmbedding('seed', [1, 0]);

		const result = await getSimilarSongsInLibrary(db, 'u1', 'seed', 10);

		expect(result).toEqual([]);
	});

	it('returns an empty array if the seed song has no embedding', async () => {
		await seedUser('u1');
		await seedSong('seed');
		await seedSong('other');
		await addToLibrary('u1', 'seed');
		await addToLibrary('u1', 'other');
		await seedEmbedding('other', [1, 0]);

		const result = await getSimilarSongsInLibrary(db, 'u1', 'seed', 10);

		expect(result).toEqual([]);
	});

	it('handles a library larger than the D1 bound-parameter chunk size', async () => {
		await seedUser('u1');
		await seedSong('seed');
		await addToLibrary('u1', 'seed');
		await seedEmbedding('seed', [1, 0]);

		const videoIds = Array.from({ length: 150 }, (_, i) => `v${i}`);
		for (const id of videoIds) {
			await seedSong(id);
			await addToLibrary('u1', id);
			await seedEmbedding(id, [0.5, 0.5]);
		}

		const result = await getSimilarSongsInLibrary(db, 'u1', 'seed', 200);

		expect(result.length).toBe(150);
	});
});
