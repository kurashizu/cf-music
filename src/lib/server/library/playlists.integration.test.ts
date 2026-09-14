import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { users, songs, playlists, playlistSongs } from '../db/schema';
import {
	createPlaylist,
	listPlaylists,
	getPlaylistWithSongs,
	renamePlaylist,
	deletePlaylist,
	addSongToPlaylist,
	removeSongFromPlaylist,
	reorderPlaylist,
	isSongInUserLibrary,
	ensureDefaultPlaylist,
	LibraryError
} from './playlists';

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
	// defaultPlaylistId references playlists.id (see schema.ts) — clearing
	// it first avoids the same foreign key violation deletePlaylist itself
	// guards against when a user's default playlist is the one being
	// deleted.
	await db.update(users).set({ defaultPlaylistId: null });
	await db.delete(playlistSongs);
	await db.delete(playlists);
	await db.delete(songs);
	await db.delete(users);
});

describe('createPlaylist / listPlaylists', () => {
	it('creates a playlist and lists it back for its owner', async () => {
		await seedUser('u1');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'My Mix' });

		const list = await listPlaylists(db, 'u1');
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe(id);
		expect(list[0].name).toBe('My Mix');
	});

	it('does not list another user\'s playlists', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await createPlaylist(db, { userId: 'u1', name: 'Owned by u1' });

		const list = await listPlaylists(db, 'u2');
		expect(list).toHaveLength(0);
	});

	it('stores an optional sourceUrl for imported playlists', async () => {
		await seedUser('u1');
		await createPlaylist(db, { userId: 'u1', name: 'Imported', sourceUrl: 'https://youtube.com/playlist?list=x' });

		const list = await listPlaylists(db, 'u1');
		expect(list[0].sourceUrl).toBe('https://youtube.com/playlist?list=x');
	});

	it('leaves sourceUrl null for a self-built playlist', async () => {
		await seedUser('u1');
		await createPlaylist(db, { userId: 'u1', name: 'Custom Mix' });

		const list = await listPlaylists(db, 'u1');
		expect(list[0].sourceUrl).toBeNull();
	});
});

describe('getPlaylistWithSongs', () => {
	it('throws not_found for a nonexistent playlist', async () => {
		await seedUser('u1');
		await expect(getPlaylistWithSongs(db, 'does-not-exist', 'u1')).rejects.toThrow(LibraryError);
	});

	it('throws not_found when the playlist belongs to a different user', async () => {
		await seedUser('u1');
		await seedUser('u2');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Private' });

		await expect(getPlaylistWithSongs(db, id, 'u2')).rejects.toThrow(LibraryError);
	});

	it('returns songs in position order', async () => {
		await seedUser('u1');
		await seedSong('a');
		await seedSong('b');
		await seedSong('c');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Ordered' });

		await addSongToPlaylist(db, id, 'u1', 'a');
		await addSongToPlaylist(db, id, 'u1', 'b');
		await addSongToPlaylist(db, id, 'u1', 'c');

		const playlist = await getPlaylistWithSongs(db, id, 'u1');
		expect(playlist.songs.map((s) => s.videoId)).toEqual(['a', 'b', 'c']);
	});
});

describe('renamePlaylist', () => {
	it('renames a playlist the caller owns', async () => {
		await seedUser('u1');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Old Name' });

		await renamePlaylist(db, id, 'u1', 'New Name');

		const playlist = await getPlaylistWithSongs(db, id, 'u1');
		expect(playlist.name).toBe('New Name');
	});

	it('rejects renaming a playlist owned by someone else', async () => {
		await seedUser('u1');
		await seedUser('u2');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mine' });

		await expect(renamePlaylist(db, id, 'u2', 'Hijacked')).rejects.toThrow(LibraryError);
	});
});

describe('deletePlaylist', () => {
	it('deletes the playlist and its song associations, leaving the song rows intact', async () => {
		await seedUser('u1');
		await seedSong('a');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Temp' });
		await addSongToPlaylist(db, id, 'u1', 'a');

		await deletePlaylist(db, id, 'u1');

		await expect(getPlaylistWithSongs(db, id, 'u1')).rejects.toThrow(LibraryError);
		const song = await db.query.songs.findFirst({ where: (t, { eq }) => eq(t.videoId, 'a') });
		expect(song).not.toBeUndefined();
	});

	it('rejects deleting a playlist owned by someone else', async () => {
		await seedUser('u1');
		await seedUser('u2');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mine' });

		await expect(deletePlaylist(db, id, 'u2')).rejects.toThrow(LibraryError);
	});

	it('clears defaultPlaylistId when deleting the playlist that was the default', async () => {
		await seedUser('u1');
		const { id } = await ensureDefaultPlaylist(db, 'u1');

		await deletePlaylist(db, id, 'u1');

		const user = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, 'u1') });
		expect(user?.defaultPlaylistId).toBeNull();
	});

	it('does not clear defaultPlaylistId when deleting an unrelated playlist', async () => {
		await seedUser('u1');
		const { id: defaultId } = await ensureDefaultPlaylist(db, 'u1');
		const { id: otherId } = await createPlaylist(db, { userId: 'u1', name: 'Other' });

		await deletePlaylist(db, otherId, 'u1');

		const user = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, 'u1') });
		expect(user?.defaultPlaylistId).toBe(defaultId);
	});
});

describe('ensureDefaultPlaylist', () => {
	it('creates an "Imports" playlist and records it as the default on first use', async () => {
		await seedUser('u1');

		const { id } = await ensureDefaultPlaylist(db, 'u1');

		const playlist = await getPlaylistWithSongs(db, id, 'u1');
		expect(playlist.name).toBe('Imports');
		const user = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, 'u1') });
		expect(user?.defaultPlaylistId).toBe(id);
	});

	it('returns the existing default on subsequent calls instead of creating another one', async () => {
		await seedUser('u1');
		const { id: first } = await ensureDefaultPlaylist(db, 'u1');

		const { id: second } = await ensureDefaultPlaylist(db, 'u1');

		expect(second).toBe(first);
		const playlists = await listPlaylists(db, 'u1');
		expect(playlists).toHaveLength(1);
	});

	it('creates a new default after the previous one was deleted', async () => {
		await seedUser('u1');
		const { id: first } = await ensureDefaultPlaylist(db, 'u1');
		await deletePlaylist(db, first, 'u1');

		const { id: second } = await ensureDefaultPlaylist(db, 'u1');

		expect(second).not.toBe(first);
		const user = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, 'u1') });
		expect(user?.defaultPlaylistId).toBe(second);
	});

	it('converges on the same playlist id when called concurrently for a user with no default yet', async () => {
		await seedUser('u1');

		const [a, b, c] = await Promise.all([
			ensureDefaultPlaylist(db, 'u1'),
			ensureDefaultPlaylist(db, 'u1'),
			ensureDefaultPlaylist(db, 'u1')
		]);

		expect(a.id).toBe(b.id);
		expect(b.id).toBe(c.id);
		const user = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, 'u1') });
		expect(user?.defaultPlaylistId).toBe(a.id);
	});
});

describe('addSongToPlaylist', () => {
	it('rejects adding a song that does not exist in the library', async () => {
		await seedUser('u1');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });

		await expect(addSongToPlaylist(db, id, 'u1', 'nonexistent')).rejects.toThrow(LibraryError);
	});

	it('is idempotent when adding the same song twice (no duplicate rows, no error)', async () => {
		await seedUser('u1');
		await seedSong('a');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });

		await addSongToPlaylist(db, id, 'u1', 'a');
		await addSongToPlaylist(db, id, 'u1', 'a');

		const playlist = await getPlaylistWithSongs(db, id, 'u1');
		expect(playlist.songs).toHaveLength(1);
	});

	it('appends new songs at the end, preserving prior order', async () => {
		await seedUser('u1');
		await seedSong('a');
		await seedSong('b');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });

		await addSongToPlaylist(db, id, 'u1', 'a');
		await addSongToPlaylist(db, id, 'u1', 'b');

		const playlist = await getPlaylistWithSongs(db, id, 'u1');
		expect(playlist.songs.map((s) => s.videoId)).toEqual(['a', 'b']);
	});

	it('allows the same song to be added to multiple playlists (dedup via shared song row)', async () => {
		await seedUser('u1');
		await seedSong('shared');
		const { id: playlistA } = await createPlaylist(db, { userId: 'u1', name: 'A' });
		const { id: playlistB } = await createPlaylist(db, { userId: 'u1', name: 'B' });

		await addSongToPlaylist(db, playlistA, 'u1', 'shared');
		await addSongToPlaylist(db, playlistB, 'u1', 'shared');

		const a = await getPlaylistWithSongs(db, playlistA, 'u1');
		const b = await getPlaylistWithSongs(db, playlistB, 'u1');
		expect(a.songs.map((s) => s.videoId)).toEqual(['shared']);
		expect(b.songs.map((s) => s.videoId)).toEqual(['shared']);
	});
});

describe('removeSongFromPlaylist', () => {
	it('removes a song from the playlist without affecting other playlists sharing it', async () => {
		await seedUser('u1');
		await seedSong('shared');
		const { id: playlistA } = await createPlaylist(db, { userId: 'u1', name: 'A' });
		const { id: playlistB } = await createPlaylist(db, { userId: 'u1', name: 'B' });
		await addSongToPlaylist(db, playlistA, 'u1', 'shared');
		await addSongToPlaylist(db, playlistB, 'u1', 'shared');

		await removeSongFromPlaylist(db, playlistA, 'u1', 'shared');

		const a = await getPlaylistWithSongs(db, playlistA, 'u1');
		const b = await getPlaylistWithSongs(db, playlistB, 'u1');
		expect(a.songs).toHaveLength(0);
		expect(b.songs).toHaveLength(1);
	});
});

describe('reorderPlaylist', () => {
	it('applies a full reorder of all songs in the playlist', async () => {
		await seedUser('u1');
		await seedSong('a');
		await seedSong('b');
		await seedSong('c');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, id, 'u1', 'a');
		await addSongToPlaylist(db, id, 'u1', 'b');
		await addSongToPlaylist(db, id, 'u1', 'c');

		await reorderPlaylist(db, id, 'u1', ['c', 'a', 'b']);

		const playlist = await getPlaylistWithSongs(db, id, 'u1');
		expect(playlist.songs.map((s) => s.videoId)).toEqual(['c', 'a', 'b']);
	});

	it('rejects a reorder that omits a song currently in the playlist', async () => {
		await seedUser('u1');
		await seedSong('a');
		await seedSong('b');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, id, 'u1', 'a');
		await addSongToPlaylist(db, id, 'u1', 'b');

		await expect(reorderPlaylist(db, id, 'u1', ['a'])).rejects.toThrow(LibraryError);
	});

	it('rejects a reorder that introduces a song not in the playlist', async () => {
		await seedUser('u1');
		await seedSong('a');
		await seedSong('intruder');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, id, 'u1', 'a');

		await expect(reorderPlaylist(db, id, 'u1', ['a', 'intruder'])).rejects.toThrow(LibraryError);
	});
});

describe('isSongInUserLibrary', () => {
	it('returns true when the song is in one of the user\'s playlists', async () => {
		await seedUser('u1');
		await seedSong('a');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, id, 'u1', 'a');

		await expect(isSongInUserLibrary(db, 'u1', 'a')).resolves.toBe(true);
	});

	it('returns false when the song exists but only in another user\'s playlist', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await seedSong('shared');
		const { id } = await createPlaylist(db, { userId: 'u2', name: 'Their Mix' });
		await addSongToPlaylist(db, id, 'u2', 'shared');

		await expect(isSongInUserLibrary(db, 'u1', 'shared')).resolves.toBe(false);
	});

	it('returns false for a video id that does not exist anywhere', async () => {
		await seedUser('u1');
		await expect(isSongInUserLibrary(db, 'u1', 'does-not-exist')).resolves.toBe(false);
	});
});
