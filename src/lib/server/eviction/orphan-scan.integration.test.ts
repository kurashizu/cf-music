import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { songs } from '../db/schema';
import type { ObjectStorage } from '../storage/s3';
import { findOrphanedObjects } from './orphan-scan';

const db = getDb(env.DB);

class FakeObjectStorage implements ObjectStorage {
	constructor(private readonly keys: string[]) {}

	async presignGetUrl(key: string): Promise<string> {
		return `https://fake.example/${key}`;
	}

	async deleteObjects(): Promise<void> {}

	async listAllKeys(): Promise<string[]> {
		return this.keys;
	}
}

async function seedSong(videoId: string, overrides: Partial<typeof songs.$inferInsert> = {}) {
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
			fileSizeBytes: 100_000,
			...overrides
		})
		.onConflictDoNothing();
}

beforeEach(async () => {
	await db.delete(songs);
});

describe('findOrphanedObjects', () => {
	it('reports nothing orphaned when the bucket is empty', async () => {
		const result = await findOrphanedObjects(db, new FakeObjectStorage([]));
		expect(result.orphanKeys).toEqual([]);
	});

	it('reports a key with no matching song row as orphaned', async () => {
		const storage = new FakeObjectStorage(['audio/stray.webm']);
		const result = await findOrphanedObjects(db, storage);
		expect(result.orphanKeys).toEqual(['audio/stray.webm']);
	});

	it('does not report a song\'s own audioKey or coverKey as orphaned', async () => {
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: 'covers/a.avif' });
		const storage = new FakeObjectStorage(['audio/a.webm', 'covers/a.avif']);
		const result = await findOrphanedObjects(db, storage);
		expect(result.orphanKeys).toEqual([]);
	});

	it('reports only the unreferenced keys out of a mixed bucket', async () => {
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: null });
		const storage = new FakeObjectStorage(['audio/a.webm', 'audio/orphan.webm', 'covers/orphan.avif']);
		const result = await findOrphanedObjects(db, storage);
		expect(result.orphanKeys.sort()).toEqual(['audio/orphan.webm', 'covers/orphan.avif']);
	});

	it('treats a song with no coverKey as not referencing any cover object', async () => {
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: null });
		const storage = new FakeObjectStorage(['audio/a.webm']);
		const result = await findOrphanedObjects(db, storage);
		expect(result.orphanKeys).toEqual([]);
		expect(result.totalReferencedKeys).toBe(1);
	});
});
