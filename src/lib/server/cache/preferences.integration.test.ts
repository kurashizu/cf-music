import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { users, songs, playlists, playlistSongs, cachePreferences } from '../db/schema';
import { listCachePreferences, setCachePreference } from './preferences';
import { createPlaylist, addSongToPlaylist } from '../library/playlists';

const db = getDb(env.DB);

async function seedUser(id: string) {
	await db.insert(users).values({ id, username: `user-${id}`, passwordHash: 'x' }).onConflictDoNothing();
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
	// defaultPlaylistId references playlists.id (see schema.ts) — clear it
	// before deleting playlists/users, or a user left with a default from
	// a previous test violates that foreign key.
	await db.update(users).set({ defaultPlaylistId: null });
	await db.delete(cachePreferences);
	await db.delete(playlistSongs);
	await db.delete(playlists);
	await db.delete(songs);
	await db.delete(users);
});

describe('listCachePreferences', () => {
	it('returns an empty array for a user with no songs', async () => {
		await seedUser('u1');
		expect(await listCachePreferences(db, 'u1')).toEqual([]);
	});

	it('defaults every song to lazy when no preference has been set', async () => {
		await seedUser('u1');
		await seedSong('a', { title: 'Song A', fileSizeBytes: 500 });
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, id, 'u1', 'a');

		const result = await listCachePreferences(db, 'u1');

		expect(result).toEqual([{ videoId: 'a', title: 'Song A', fileSizeBytes: 500, cacheType: 'lazy' }]);
	});

	it('reflects a pinned preference once set', async () => {
		await seedUser('u1');
		await seedSong('a');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, id, 'u1', 'a');
		await setCachePreference(db, 'u1', 'a', 'pinned');

		const result = await listCachePreferences(db, 'u1');

		expect(result[0].cacheType).toBe('pinned');
	});

	it('only reflects preferences for songs actually in the caller\'s own library', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await seedSong('shared');
		const { id: p1 } = await createPlaylist(db, { userId: 'u1', name: 'Mix 1' });
		await addSongToPlaylist(db, p1, 'u1', 'shared');
		const { id: p2 } = await createPlaylist(db, { userId: 'u2', name: 'Mix 2' });
		await addSongToPlaylist(db, p2, 'u2', 'shared');

		// u2 pins their copy of the shared song; u1's own preference is untouched.
		await setCachePreference(db, 'u2', 'shared', 'pinned');

		const u1Result = await listCachePreferences(db, 'u1');
		expect(u1Result[0].cacheType).toBe('lazy');
	});
});

describe('setCachePreference', () => {
	it('creates a row when pinning a song for the first time', async () => {
		await seedUser('u1');
		await seedSong('a');

		await setCachePreference(db, 'u1', 'a', 'pinned');

		const row = await db.query.cachePreferences.findFirst({
			where: (t, { eq, and }) => and(eq(t.userId, 'u1'), eq(t.videoId, 'a'))
		});
		expect(row?.cacheType).toBe('pinned');
	});

	it('updates an existing row rather than erroring on a second pin call', async () => {
		await seedUser('u1');
		await seedSong('a');
		await setCachePreference(db, 'u1', 'a', 'pinned');

		await expect(setCachePreference(db, 'u1', 'a', 'pinned')).resolves.not.toThrow();
	});

	it('deletes the row when set back to lazy', async () => {
		await seedUser('u1');
		await seedSong('a');
		await setCachePreference(db, 'u1', 'a', 'pinned');

		await setCachePreference(db, 'u1', 'a', 'lazy');

		const row = await db.query.cachePreferences.findFirst({
			where: (t, { eq, and }) => and(eq(t.userId, 'u1'), eq(t.videoId, 'a'))
		});
		expect(row).toBeUndefined();
	});

	it('setting lazy when no row exists is a no-op, not an error', async () => {
		await seedUser('u1');
		await seedSong('a');

		await expect(setCachePreference(db, 'u1', 'a', 'lazy')).resolves.not.toThrow();
	});
});
