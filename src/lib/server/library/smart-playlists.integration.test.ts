import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { users, songs, playlists, playlistSongs } from '../db/schema';
import { createPlaylist, addSongToPlaylist } from './playlists';
import { listSmartPlaylists, parseSmartPlaylistId, getSmartPlaylistSongs } from './smart-playlists';

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
			fileSizeBytes: 1000,
			...overrides
		})
		.onConflictDoNothing();
}

beforeEach(async () => {
	// defaultPlaylistId references playlists.id (see schema.ts) — clear it
	// before deleting playlists/users, or a user left with a default from
	// a previous test violates that foreign key.
	await db.update(users).set({ defaultPlaylistId: null });
	await db.delete(playlistSongs);
	await db.delete(playlists);
	await db.delete(songs);
	await db.delete(users);
});

describe('listSmartPlaylists', () => {
	it('returns nothing for a user with no songs', async () => {
		await seedUser('u1');
		expect(await listSmartPlaylists(db, 'u1')).toEqual([]);
	});

	it('groups songs by artist and by genre independently', async () => {
		await seedUser('u1');
		await seedSong('a', { artist: 'Radiohead', genre: 'Rock' });
		await seedSong('b', { artist: 'Radiohead', genre: 'Alternative' });
		const { id: p1 } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, p1, 'u1', 'a');
		await addSongToPlaylist(db, p1, 'u1', 'b');

		const groups = await listSmartPlaylists(db, 'u1');
		const artistGroup = groups.find((g) => g.id === 'artist:Radiohead');
		expect(artistGroup?.songCount).toBe(2);
		expect(groups.find((g) => g.id === 'genre:Rock')?.songCount).toBe(1);
		expect(groups.find((g) => g.id === 'genre:Alternative')?.songCount).toBe(1);
	});

	it('excludes songs with no artist/genre set from those groupings', async () => {
		await seedUser('u1');
		await seedSong('a', { artist: null, genre: null });
		const { id: p1 } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, p1, 'u1', 'a');

		expect(await listSmartPlaylists(db, 'u1')).toEqual([]);
	});

	it('only counts songs reachable through this user\'s own playlists', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await seedSong('a', { artist: 'Shared Artist' });
		const { id: p1 } = await createPlaylist(db, { userId: 'u2', name: 'Someone else\'s' });
		await addSongToPlaylist(db, p1, 'u2', 'a');

		expect(await listSmartPlaylists(db, 'u1')).toEqual([]);
	});

	it('counts a song only once per field even if it is in multiple of the user\'s playlists', async () => {
		await seedUser('u1');
		await seedSong('a', { artist: 'Radiohead' });
		const { id: p1 } = await createPlaylist(db, { userId: 'u1', name: 'Mix 1' });
		const { id: p2 } = await createPlaylist(db, { userId: 'u1', name: 'Mix 2' });
		await addSongToPlaylist(db, p1, 'u1', 'a');
		await addSongToPlaylist(db, p2, 'u1', 'a');

		const groups = await listSmartPlaylists(db, 'u1');
		expect(groups.find((g) => g.id === 'artist:Radiohead')?.songCount).toBe(1);
	});
});

describe('parseSmartPlaylistId', () => {
	it('parses a valid artist id', () => {
		expect(parseSmartPlaylistId('artist:Radiohead')).toEqual({ field: 'artist', value: 'Radiohead' });
	});

	it('parses a valid genre id', () => {
		expect(parseSmartPlaylistId('genre:Rock')).toEqual({ field: 'genre', value: 'Rock' });
	});

	it('preserves a colon that is part of the value itself', () => {
		expect(parseSmartPlaylistId('artist:DJ: The Mix')).toEqual({ field: 'artist', value: 'DJ: The Mix' });
	});

	it('rejects an unknown field', () => {
		expect(parseSmartPlaylistId('album:Foo')).toBeNull();
	});

	it('rejects a string with no separator', () => {
		expect(parseSmartPlaylistId('artist')).toBeNull();
	});

	it('rejects an empty value', () => {
		expect(parseSmartPlaylistId('artist:')).toBeNull();
	});
});

describe('getSmartPlaylistSongs', () => {
	it('returns only songs matching the given artist', async () => {
		await seedUser('u1');
		await seedSong('a', { artist: 'Radiohead', title: 'Song A' });
		await seedSong('b', { artist: 'Someone Else', title: 'Song B' });
		const { id: p1 } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, p1, 'u1', 'a');
		await addSongToPlaylist(db, p1, 'u1', 'b');

		const result = await getSmartPlaylistSongs(db, 'u1', 'artist', 'Radiohead');
		expect(result.map((s) => s.videoId)).toEqual(['a']);
	});

	it('does not return another user\'s songs even with a matching artist value', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await seedSong('a', { artist: 'Radiohead' });
		const { id: p1 } = await createPlaylist(db, { userId: 'u2', name: 'Mix' });
		await addSongToPlaylist(db, p1, 'u2', 'a');

		expect(await getSmartPlaylistSongs(db, 'u1', 'artist', 'Radiohead')).toEqual([]);
	});
});
