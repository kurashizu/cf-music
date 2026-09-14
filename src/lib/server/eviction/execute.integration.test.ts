import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { users, songs, playlists, playlistSongs, auditLog } from '../db/schema';
import type { ObjectStorage } from '../storage/s3';
import { previewEvictionForImport, evictSongForUser, executeEvictionPlan } from './execute';
import { eq } from 'drizzle-orm';

const db = getDb(env.DB);

class FakeObjectStorage implements ObjectStorage {
	deletedKeys: string[] = [];

	async presignGetUrl(key: string): Promise<string> {
		return `https://fake.example/${key}`;
	}

	async deleteObjects(keys: string[]): Promise<void> {
		this.deletedKeys.push(...keys);
	}

	async listAllKeys(): Promise<string[]> {
		return [];
	}
}

async function seedUser(id: string, quotaBytes = 1_000_000) {
	await db
		.insert(users)
		.values({ id, username: `user-${id}`, passwordHash: 'x', storageQuotaBytes: quotaBytes })
		.onConflictDoNothing();
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
			coverKey: `covers/${videoId}.avif`,
			codec: 'opus',
			container: 'webm',
			fileSizeBytes: 100_000,
			...overrides
		})
		.onConflictDoNothing();
}

async function seedPlaylistWithSong(playlistId: string, userId: string, videoId: string) {
	await db.insert(playlists).values({ id: playlistId, userId, name: `Playlist ${playlistId}` });
	await db.insert(playlistSongs).values({ playlistId, videoId, position: 0 });
}

beforeEach(async () => {
	// defaultPlaylistId references playlists.id (see schema.ts) — clear it
	// before deleting playlists/users, or a user left with a default from
	// a previous test violates that foreign key.
	await db.update(users).set({ defaultPlaylistId: null });
	await db.delete(auditLog);
	await db.delete(playlistSongs);
	await db.delete(playlists);
	await db.delete(songs);
	await db.delete(users);
});

describe('previewEvictionForImport', () => {
	it('reports "fits" when the incoming file fits within remaining quota', async () => {
		await seedUser('u1', 1_000_000);

		const result = await previewEvictionForImport(db, 'u1', 100_000);
		expect(result.outcome).toBe('fits');
	});

	it('reports "exceeds_total_quota" when the file is bigger than the whole quota', async () => {
		await seedUser('u1', 1_000_000);

		const result = await previewEvictionForImport(db, 'u1', 2_000_000);
		expect(result.outcome).toBe('exceeds_total_quota');
	});

	it('reports "needs_eviction" with a plan naming real songs from the user\'s library', async () => {
		await seedUser('u1', 150_000);
		await seedSong('a', { fileSizeBytes: 100_000 });
		await seedPlaylistWithSong('p1', 'u1', 'a');

		const result = await previewEvictionForImport(db, 'u1', 100_000);
		expect(result.outcome).toBe('needs_eviction');
		if (result.outcome === 'needs_eviction') {
			expect(result.plan.toEvict.map((c) => c.videoId)).toEqual(['a']);
		}
	});
});

describe('evictSongForUser', () => {
	it('hard-deletes the song and its S3 objects when no playlist references it afterward', async () => {
		await seedUser('u1');
		await seedSong('a');
		await seedPlaylistWithSong('p1', 'u1', 'a');
		const storage = new FakeObjectStorage();

		await evictSongForUser(db, storage, 'u1', 'a');

		const song = await db.query.songs.findFirst({ where: eq(songs.videoId, 'a') });
		expect(song).toBeUndefined();
		expect(storage.deletedKeys).toEqual(['audio/a.webm', 'covers/a.avif']);
	});

	it('only unlinks the reference (no S3 delete) when another user\'s playlist still references the song', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await seedSong('shared');
		await seedPlaylistWithSong('p1', 'u1', 'shared');
		await seedPlaylistWithSong('p2', 'u2', 'shared');
		const storage = new FakeObjectStorage();

		await evictSongForUser(db, storage, 'u1', 'shared');

		const song = await db.query.songs.findFirst({ where: eq(songs.videoId, 'shared') });
		expect(song).not.toBeUndefined();
		expect(storage.deletedKeys).toEqual([]);

		const u2Ref = await db.query.playlistSongs.findFirst({
			where: eq(playlistSongs.playlistId, 'p2')
		});
		expect(u2Ref).not.toBeUndefined();
	});

	it('removes references from every playlist the user owns, not just one', async () => {
		await seedUser('u1');
		await seedSong('a');
		await seedPlaylistWithSong('p1', 'u1', 'a');
		await seedPlaylistWithSong('p2', 'u1', 'a');
		const storage = new FakeObjectStorage();

		await evictSongForUser(db, storage, 'u1', 'a');

		const remaining = await db.query.playlistSongs.findMany({ where: eq(playlistSongs.videoId, 'a') });
		expect(remaining).toHaveLength(0);
	});

	it('is a no-op when the song does not exist', async () => {
		await seedUser('u1');
		const storage = new FakeObjectStorage();

		await expect(evictSongForUser(db, storage, 'u1', 'does-not-exist')).resolves.not.toThrow();
		expect(storage.deletedKeys).toEqual([]);
	});

	it('records an audit log entry with hardDeleted=true when fully removed', async () => {
		await seedUser('u1');
		await seedSong('a');
		await seedPlaylistWithSong('p1', 'u1', 'a');
		const storage = new FakeObjectStorage();

		await evictSongForUser(db, storage, 'u1', 'a');

		const [entry] = await db.query.auditLog.findMany({ where: eq(auditLog.eventType, 'evict') });
		expect(entry).not.toBeUndefined();
		expect(entry.targetId).toBe('a');
		expect(JSON.parse(entry.detail!).hardDeleted).toBe(true);
	});

	it('records an audit log entry with hardDeleted=false when only unlinked', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await seedSong('shared');
		await seedPlaylistWithSong('p1', 'u1', 'shared');
		await seedPlaylistWithSong('p2', 'u2', 'shared');
		const storage = new FakeObjectStorage();

		await evictSongForUser(db, storage, 'u1', 'shared');

		const [entry] = await db.query.auditLog.findMany({ where: eq(auditLog.eventType, 'evict') });
		expect(JSON.parse(entry.detail!).hardDeleted).toBe(false);
	});

	it('tags manual deletion with the manual_delete audit event type', async () => {
		await seedUser('u1');
		await seedSong('a');
		await seedPlaylistWithSong('p1', 'u1', 'a');
		const storage = new FakeObjectStorage();

		await evictSongForUser(db, storage, 'u1', 'a', 'manual_delete');

		const entries = await db.query.auditLog.findMany();
		expect(entries[0].eventType).toBe('manual_delete');
	});
});

describe('executeEvictionPlan', () => {
	it('evicts every song in the given list', async () => {
		await seedUser('u1');
		await seedSong('a');
		await seedSong('b');
		await seedPlaylistWithSong('p1', 'u1', 'a');
		await seedPlaylistWithSong('p2', 'u1', 'b');
		const storage = new FakeObjectStorage();

		await executeEvictionPlan(db, storage, 'u1', ['a', 'b']);

		const remainingSongs = await db.query.songs.findMany();
		expect(remainingSongs).toHaveLength(0);
	});
});
