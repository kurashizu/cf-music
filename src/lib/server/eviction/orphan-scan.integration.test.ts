import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { songs, users, auditLog, playlists, playlistSongs } from '../db/schema';
import type { ObjectStorage } from '../storage/s3';
import {
	findOrphanedObjects,
	findDeadSongReferences,
	resolveDeadSongReference,
	findUnreferencedSongs,
	resolveUnreferencedSong
} from './orphan-scan';
import { createPlaylist, addSongToPlaylist } from '../library/playlists';

const db = getDb(env.DB);

class FakeObjectStorage implements ObjectStorage {
	constructor(private readonly keys: string[]) {}

	async presignGetUrl(key: string): Promise<string> {
		return `https://fake.example/${key}`;
	}

	async deleteObjects(_keys: string[]): Promise<void> {}

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

async function seedUser(id: string) {
	await db
		.insert(users)
		.values({ id, username: `user-${id}`, passwordHash: 'x' })
		.onConflictDoNothing();
}

beforeEach(async () => {
	// defaultPlaylistId references playlists.id (see schema.ts) — clear it
	// before deleting playlists/users, or a leftover default from a
	// previous test violates that foreign key.
	await db.update(users).set({ defaultPlaylistId: null });
	await db.delete(auditLog);
	await db.delete(playlistSongs);
	await db.delete(playlists);
	await db.delete(songs);
	await db.delete(users);
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

	it("does not report a song's own audioKey or coverKey as orphaned", async () => {
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: 'covers/a.avif' });
		const storage = new FakeObjectStorage(['audio/a.webm', 'covers/a.avif']);
		const result = await findOrphanedObjects(db, storage);
		expect(result.orphanKeys).toEqual([]);
	});

	it('reports only the unreferenced keys out of a mixed bucket', async () => {
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: null });
		const storage = new FakeObjectStorage([
			'audio/a.webm',
			'audio/orphan.webm',
			'covers/orphan.avif'
		]);
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

	it('excludes ci-state/ keys from both orphanKeys and totalBucketKeys', async () => {
		const storage = new FakeObjectStorage([
			'ci-state/www.youtube.com_cookies.txt',
			'audio/stray.webm'
		]);
		const result = await findOrphanedObjects(db, storage);
		expect(result.orphanKeys).toEqual(['audio/stray.webm']);
		expect(result.totalBucketKeys).toBe(1);
	});
});

describe('findDeadSongReferences', () => {
	it("reports nothing dead when every song's objects exist in the bucket", async () => {
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: 'covers/a.avif' });
		const storage = new FakeObjectStorage(['audio/a.webm', 'covers/a.avif']);
		const result = await findDeadSongReferences(db, storage);
		expect(result.deadReferences).toEqual([]);
	});

	it("reports a song's audioKey as dead when it is missing from the bucket", async () => {
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: null });
		const storage = new FakeObjectStorage([]);
		const result = await findDeadSongReferences(db, storage);
		expect(result.deadReferences).toEqual([
			{ videoId: 'a', title: 'Song a', field: 'audioKey', key: 'audio/a.webm' }
		]);
	});

	it("reports a song's coverKey as dead independently of its audioKey", async () => {
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: 'covers/a.avif' });
		const storage = new FakeObjectStorage(['audio/a.webm']);
		const result = await findDeadSongReferences(db, storage);
		expect(result.deadReferences).toEqual([
			{ videoId: 'a', title: 'Song a', field: 'coverKey', key: 'covers/a.avif' }
		]);
	});

	it('does not report a dead coverKey for a song with no coverKey at all', async () => {
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: null });
		const storage = new FakeObjectStorage(['audio/a.webm']);
		const result = await findDeadSongReferences(db, storage);
		expect(result.deadReferences).toEqual([]);
	});

	it('reports both audioKey and coverKey as dead for the same song when both are missing', async () => {
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: 'covers/a.avif' });
		const storage = new FakeObjectStorage([]);
		const result = await findDeadSongReferences(db, storage);
		expect(result.deadReferences).toEqual([
			{ videoId: 'a', title: 'Song a', field: 'audioKey', key: 'audio/a.webm' },
			{ videoId: 'a', title: 'Song a', field: 'coverKey', key: 'covers/a.avif' }
		]);
	});

	it("does not flag one song's missing object as dead for a different song sharing no keys", async () => {
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: null });
		await seedSong('b', { audioKey: 'audio/b.webm', coverKey: null });
		const storage = new FakeObjectStorage(['audio/a.webm']);
		const result = await findDeadSongReferences(db, storage);
		expect(result.deadReferences).toEqual([
			{ videoId: 'b', title: 'Song b', field: 'audioKey', key: 'audio/b.webm' }
		]);
	});
});

describe('resolveDeadSongReference', () => {
	it('deletes the whole song row for a dead audioKey (song has no audio at all)', async () => {
		await seedUser('admin1');
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: null });

		await resolveDeadSongReference(db, 'admin1', {
			videoId: 'a',
			title: 'Song a',
			field: 'audioKey',
			key: 'audio/a.webm'
		});

		const song = await db.query.songs.findFirst({ where: eq(songs.videoId, 'a') });
		expect(song).toBeUndefined();
	});

	it('only clears the coverKey for a dead coverKey, keeping the rest of the song row intact', async () => {
		await seedUser('admin1');
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: 'covers/a.avif', title: 'Keep Me' });

		await resolveDeadSongReference(db, 'admin1', {
			videoId: 'a',
			title: 'Song a',
			field: 'coverKey',
			key: 'covers/a.avif'
		});

		const song = await db.query.songs.findFirst({ where: eq(songs.videoId, 'a') });
		expect(song?.coverKey).toBeNull();
		expect(song?.title).toBe('Keep Me');
		expect(song?.audioKey).toBe('audio/a.webm');
	});

	it('records an audit event with the acting admin as actorId for an audioKey resolution', async () => {
		await seedUser('admin1');
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: null });

		await resolveDeadSongReference(db, 'admin1', {
			videoId: 'a',
			title: 'Song a',
			field: 'audioKey',
			key: 'audio/a.webm'
		});

		const entry = await db.query.auditLog.findFirst({ where: eq(auditLog.targetId, 'a') });
		expect(entry?.actorId).toBe('admin1');
		expect(entry?.eventType).toBe('manual_delete');
	});

	it('records a distinct audit event type for a coverKey resolution', async () => {
		await seedUser('admin1');
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: 'covers/a.avif' });

		await resolveDeadSongReference(db, 'admin1', {
			videoId: 'a',
			title: 'Song a',
			field: 'coverKey',
			key: 'covers/a.avif'
		});

		const entry = await db.query.auditLog.findFirst({ where: eq(auditLog.targetId, 'a') });
		expect(entry?.eventType).toBe('cover_reference_cleared');
	});

	it('reports resolved: true when the audioKey delete actually removes a row', async () => {
		await seedUser('admin1');
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: null });

		const result = await resolveDeadSongReference(db, 'admin1', {
			videoId: 'a',
			title: 'Song a',
			field: 'audioKey',
			key: 'audio/a.webm'
		});

		expect(result.resolved).toBe(true);
	});

	it('reports resolved: false and writes no audit event on a second concurrent resolve of the same audioKey reference', async () => {
		await seedUser('admin1');
		await seedUser('admin2');
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: null });

		const first = await resolveDeadSongReference(db, 'admin1', {
			videoId: 'a',
			title: 'Song a',
			field: 'audioKey',
			key: 'audio/a.webm'
		});
		// The row is already gone - a second admin resolving "the same"
		// reference (e.g. both had it open in their own scan results) finds
		// nothing left to delete.
		const second = await resolveDeadSongReference(db, 'admin2', {
			videoId: 'a',
			title: 'Song a',
			field: 'audioKey',
			key: 'audio/a.webm'
		});

		expect(first.resolved).toBe(true);
		expect(second.resolved).toBe(false);
		const entries = await db.query.auditLog.findMany({ where: eq(auditLog.targetId, 'a') });
		expect(entries).toHaveLength(1);
		expect(entries[0].actorId).toBe('admin1');
	});

	it('reports resolved: false and writes no audit event when the coverKey no longer matches (changed since the scan)', async () => {
		await seedUser('admin1');
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: 'covers/new.avif' });

		// Resolving a stale reference to the *old* cover key, which this
		// song no longer actually has.
		const result = await resolveDeadSongReference(db, 'admin1', {
			videoId: 'a',
			title: 'Song a',
			field: 'coverKey',
			key: 'covers/old.avif'
		});

		expect(result.resolved).toBe(false);
		const song = await db.query.songs.findFirst({ where: eq(songs.videoId, 'a') });
		expect(song?.coverKey).toBe('covers/new.avif');
		const entries = await db.query.auditLog.findMany({ where: eq(auditLog.targetId, 'a') });
		expect(entries).toHaveLength(0);
	});
});

describe('findUnreferencedSongs', () => {
	it('reports nothing unreferenced when every song is reachable through a playlist', async () => {
		await seedUser('admin1');
		await seedSong('a');
		const { id: playlistId } = await createPlaylist(db, { userId: 'admin1', name: 'Mix' });
		await addSongToPlaylist(db, playlistId, 'admin1', 'a');

		const result = await findUnreferencedSongs(db);

		expect(result.unreferencedSongs).toEqual([]);
		expect(result.totalSongs).toBe(1);
	});

	it('reports a song with no playlist_songs row at all as unreferenced', async () => {
		await seedSong('a', { title: 'Orphan Song' });

		const result = await findUnreferencedSongs(db);

		expect(result.unreferencedSongs).toEqual([{ videoId: 'a', title: 'Orphan Song' }]);
	});

	it('does not flag a song that lost one playlist reference but still has another', async () => {
		await seedUser('admin1');
		await seedSong('a');
		const { id: p1 } = await createPlaylist(db, { userId: 'admin1', name: 'Mix 1' });
		const { id: p2 } = await createPlaylist(db, { userId: 'admin1', name: 'Mix 2' });
		await addSongToPlaylist(db, p1, 'admin1', 'a');
		await addSongToPlaylist(db, p2, 'admin1', 'a');

		const result = await findUnreferencedSongs(db);

		expect(result.unreferencedSongs).toEqual([]);
	});

	it('reports only the unreferenced songs out of a mix of referenced and unreferenced', async () => {
		await seedUser('admin1');
		await seedSong('a');
		await seedSong('b');
		const { id: playlistId } = await createPlaylist(db, { userId: 'admin1', name: 'Mix' });
		await addSongToPlaylist(db, playlistId, 'admin1', 'a');

		const result = await findUnreferencedSongs(db);

		expect(result.unreferencedSongs).toEqual([{ videoId: 'b', title: 'Song b' }]);
		expect(result.totalSongs).toBe(2);
	});
});

describe('resolveUnreferencedSong', () => {
	it('deletes the song row', async () => {
		await seedUser('admin1');
		await seedSong('a');

		await resolveUnreferencedSong(db, new FakeObjectStorage([]), 'admin1', 'a');

		const song = await db.query.songs.findFirst({ where: eq(songs.videoId, 'a') });
		expect(song).toBeUndefined();
	});

	it('deletes both the audio and cover objects from storage', async () => {
		await seedUser('admin1');
		await seedSong('a', { audioKey: 'audio/a.webm', coverKey: 'covers/a.avif' });
		const deleted: string[][] = [];
		class RecordingStorage extends FakeObjectStorage {
			async deleteObjects(keys: string[]): Promise<void> {
				deleted.push(keys);
			}
		}

		await resolveUnreferencedSong(db, new RecordingStorage([]), 'admin1', 'a');

		expect(deleted).toEqual([['audio/a.webm', 'covers/a.avif']]);
	});

	it('records an audit event with the acting admin as actorId', async () => {
		await seedUser('admin1');
		await seedSong('a');

		await resolveUnreferencedSong(db, new FakeObjectStorage([]), 'admin1', 'a');

		const entry = await db.query.auditLog.findFirst({ where: eq(auditLog.targetId, 'a') });
		expect(entry?.actorId).toBe('admin1');
		expect(entry?.eventType).toBe('manual_delete');
	});

	it('reports resolved: true when the delete actually removes a row', async () => {
		await seedUser('admin1');
		await seedSong('a');

		const result = await resolveUnreferencedSong(db, new FakeObjectStorage([]), 'admin1', 'a');

		expect(result.resolved).toBe(true);
	});

	it('reports resolved: false and writes no audit event on a second concurrent resolve of the same song', async () => {
		await seedUser('admin1');
		await seedUser('admin2');
		await seedSong('a');

		const first = await resolveUnreferencedSong(db, new FakeObjectStorage([]), 'admin1', 'a');
		const second = await resolveUnreferencedSong(db, new FakeObjectStorage([]), 'admin2', 'a');

		expect(first.resolved).toBe(true);
		expect(second.resolved).toBe(false);
		const entries = await db.query.auditLog.findMany({ where: eq(auditLog.targetId, 'a') });
		expect(entries).toHaveLength(1);
		expect(entries[0].actorId).toBe('admin1');
	});

	it('reports resolved: false when the song no longer exists', async () => {
		await seedUser('admin1');

		const result = await resolveUnreferencedSong(
			db,
			new FakeObjectStorage([]),
			'admin1',
			'does-not-exist'
		);

		expect(result.resolved).toBe(false);
	});
});
