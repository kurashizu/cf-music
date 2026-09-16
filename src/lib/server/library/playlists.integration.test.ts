import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { users, songs, playlists, playlistSongs, importJobs } from '../db/schema';
import {
	createPlaylist,
	listPlaylists,
	getPlaylistWithSongs,
	renamePlaylist,
	deletePlaylist,
	addSongToPlaylist,
	removeSongFromPlaylist,
	moveSongToPlaylist,
	reorderPlaylist,
	isSongInUserLibrary,
	ensureDefaultPlaylist,
	listUserLibrarySongs,
	LibraryError
} from './playlists';
import { recordSongPlay } from './plays';

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
	// defaultPlaylistId/import_jobs.target_playlist_id both reference
	// playlists.id (see schema.ts) — clearing/deleting them first avoids
	// the same foreign key violations deletePlaylist itself guards against
	// when a user's default playlist, or one an import job targeted, is
	// the one being deleted.
	await db.update(users).set({ defaultPlaylistId: null });
	await db.delete(importJobs);
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

	it('returns up to 4 member songs\' coverKeys in playlist order, skipping songs with none', async () => {
		await seedUser('u1');
		await seedSong('a', { coverKey: 'covers/a.avif' });
		await seedSong('b', { coverKey: null });
		await seedSong('c', { coverKey: 'covers/c.avif' });
		await seedSong('d', { coverKey: 'covers/d.avif' });
		await seedSong('e', { coverKey: 'covers/e.avif' });
		await seedSong('f', { coverKey: 'covers/f.avif' });
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		for (const videoId of ['a', 'b', 'c', 'd', 'e', 'f']) {
			await addSongToPlaylist(db, id, 'u1', videoId);
		}

		const list = await listPlaylists(db, 'u1');
		expect(list[0].coverKeys).toEqual(['covers/a.avif', 'covers/c.avif', 'covers/d.avif', 'covers/e.avif']);
	});

	it('returns an empty coverKeys array for a playlist with no songs (or none with a cover)', async () => {
		await seedUser('u1');
		await createPlaylist(db, { userId: 'u1', name: 'Empty' });

		const list = await listPlaylists(db, 'u1');
		expect(list[0].coverKeys).toEqual([]);
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

	it('rejects renaming the default playlist', async () => {
		await seedUser('u1');
		const { id } = await ensureDefaultPlaylist(db, 'u1');

		await expect(renamePlaylist(db, id, 'u1', 'My Library')).rejects.toThrow(LibraryError);

		const playlist = await getPlaylistWithSongs(db, id, 'u1');
		expect(playlist.name).toBe('All Imported');
	});

	it('rejects renaming a system-generated (auto_tag) playlist', async () => {
		await seedUser('u1');
		const [{ id }] = await db
			.insert(playlists)
			.values({ userId: 'u1', name: 'jazz', type: 'auto_tag', tag: 'jazz', facet: 'genre' })
			.returning({ id: playlists.id });

		await expect(renamePlaylist(db, id, 'u1', 'Renamed')).rejects.toThrow(LibraryError);

		const playlist = await getPlaylistWithSongs(db, id, 'u1');
		expect(playlist.name).toBe('jazz');
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

	it('rejects deleting the default playlist', async () => {
		await seedUser('u1');
		const { id } = await ensureDefaultPlaylist(db, 'u1');

		await expect(deletePlaylist(db, id, 'u1')).rejects.toThrow(LibraryError);

		const user = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, 'u1') });
		expect(user?.defaultPlaylistId).toBe(id);
	});

	it('rejects deleting a system-generated (auto_tag) playlist', async () => {
		await seedUser('u1');
		const [{ id }] = await db
			.insert(playlists)
			.values({ userId: 'u1', name: 'jazz', type: 'auto_tag', tag: 'jazz', facet: 'genre' })
			.returning({ id: playlists.id });

		await expect(deletePlaylist(db, id, 'u1')).rejects.toThrow(LibraryError);

		await expect(getPlaylistWithSongs(db, id, 'u1')).resolves.toBeDefined();
	});

	it('does not clear defaultPlaylistId when deleting an unrelated playlist', async () => {
		await seedUser('u1');
		const { id: defaultId } = await ensureDefaultPlaylist(db, 'u1');
		const { id: otherId } = await createPlaylist(db, { userId: 'u1', name: 'Other' });

		await deletePlaylist(db, otherId, 'u1');

		const user = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, 'u1') });
		expect(user?.defaultPlaylistId).toBe(defaultId);
	});

	it('deletes a playlist an import job targeted, nulling out the job\'s reference instead of failing', async () => {
		await seedUser('u1');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Imports' });
		await db.insert(importJobs).values({
			id: 'job1',
			userId: 'u1',
			sourceUrl: 'https://youtube.com/watch?v=x',
			targetPlaylistId: id,
			status: 'completed'
		});

		await deletePlaylist(db, id, 'u1');

		const job = await db.query.importJobs.findFirst({ where: (t, { eq }) => eq(t.id, 'job1') });
		expect(job?.targetPlaylistId).toBeNull();
	});
});

describe('ensureDefaultPlaylist', () => {
	it('creates an "All Imported" playlist and records it as the default on first use', async () => {
		await seedUser('u1');

		const { id } = await ensureDefaultPlaylist(db, 'u1');

		const playlist = await getPlaylistWithSongs(db, id, 'u1');
		expect(playlist.name).toBe('All Imported');
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

	it('rejects adding a song to a system-generated (auto_tag) playlist', async () => {
		await seedUser('u1');
		await seedSong('a');
		const [{ id }] = await db
			.insert(playlists)
			.values({ userId: 'u1', name: 'jazz', type: 'auto_tag', tag: 'jazz', facet: 'genre' })
			.returning({ id: playlists.id });

		await expect(addSongToPlaylist(db, id, 'u1', 'a')).rejects.toThrow(LibraryError);
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

	it('rejects removing a song from the default playlist', async () => {
		await seedUser('u1');
		await seedSong('a');
		const { id } = await ensureDefaultPlaylist(db, 'u1');
		await addSongToPlaylist(db, id, 'u1', 'a');

		await expect(removeSongFromPlaylist(db, id, 'u1', 'a')).rejects.toThrow(LibraryError);

		const playlist = await getPlaylistWithSongs(db, id, 'u1');
		expect(playlist.songs).toHaveLength(1);
	});

	it('rejects removing a song from a system-generated (auto_tag) playlist', async () => {
		await seedUser('u1');
		await seedSong('a');
		const [{ id }] = await db
			.insert(playlists)
			.values({ userId: 'u1', name: 'jazz', type: 'auto_tag', tag: 'jazz', facet: 'genre' })
			.returning({ id: playlists.id });
		await db.insert(playlistSongs).values({ playlistId: id, videoId: 'a', position: 0 });

		await expect(removeSongFromPlaylist(db, id, 'u1', 'a')).rejects.toThrow(LibraryError);
	});
});

describe('moveSongToPlaylist', () => {
	it('adds the song to the target and removes it from the source', async () => {
		await seedUser('u1');
		await seedSong('a');
		const { id: from } = await createPlaylist(db, { userId: 'u1', name: 'From' });
		const { id: to } = await createPlaylist(db, { userId: 'u1', name: 'To' });
		await addSongToPlaylist(db, from, 'u1', 'a');

		await moveSongToPlaylist(db, 'u1', from, to, 'a');

		const fromPlaylist = await getPlaylistWithSongs(db, from, 'u1');
		const toPlaylist = await getPlaylistWithSongs(db, to, 'u1');
		expect(fromPlaylist.songs).toHaveLength(0);
		expect(toPlaylist.songs.map((s) => s.videoId)).toEqual(['a']);
	});

	it('rejects moving a song out of the default playlist, leaving both playlists untouched', async () => {
		await seedUser('u1');
		await seedSong('a');
		const { id: defaultPlaylistId } = await ensureDefaultPlaylist(db, 'u1');
		const { id: to } = await createPlaylist(db, { userId: 'u1', name: 'To' });
		await addSongToPlaylist(db, defaultPlaylistId, 'u1', 'a');

		await expect(moveSongToPlaylist(db, 'u1', defaultPlaylistId, to, 'a')).rejects.toThrow(LibraryError);

		const defaultPlaylist = await getPlaylistWithSongs(db, defaultPlaylistId, 'u1');
		const toPlaylist = await getPlaylistWithSongs(db, to, 'u1');
		expect(defaultPlaylist.songs.map((s) => s.videoId)).toEqual(['a']);
		// addSongToPlaylist ran (into `to`) before the removal from the
		// default playlist was rejected — the song ends up copied into
		// `to` as a side effect, not "nothing happened at all". That's
		// consistent with moveSongToPlaylist's own doc comment: the add
		// happens first specifically so a failure partway through never
		// loses the song, even though here it means the "move" partially
		// succeeded as a copy.
		expect(toPlaylist.songs.map((s) => s.videoId)).toEqual(['a']);
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

	it('rejects reordering a system-generated (auto_tag) playlist', async () => {
		await seedUser('u1');
		await seedSong('a');
		await seedSong('b');
		const [{ id }] = await db
			.insert(playlists)
			.values({ userId: 'u1', name: 'jazz', type: 'auto_tag', tag: 'jazz', facet: 'genre' })
			.returning({ id: playlists.id });
		await db.insert(playlistSongs).values([
			{ playlistId: id, videoId: 'a', position: 0 },
			{ playlistId: id, videoId: 'b', position: 1 }
		]);

		await expect(reorderPlaylist(db, id, 'u1', ['b', 'a'])).rejects.toThrow(LibraryError);
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

describe('listUserLibrarySongs', () => {
	it('includes a never-played song with playCount 0 and no lastPlayedAt', async () => {
		await seedUser('u1');
		await seedSong('a', { artist: 'Radiohead' });
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, id, 'u1', 'a');

		const [song] = await listUserLibrarySongs(db, 'u1');
		expect(song).toMatchObject({ videoId: 'a', artist: 'Radiohead', playCount: 0, lastPlayedAt: null });
	});

	it('reports playCount and lastPlayedAt once the song has been played', async () => {
		await seedUser('u1');
		await seedSong('a');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, id, 'u1', 'a');
		await recordSongPlay(db, 'u1', 'a');
		await recordSongPlay(db, 'u1', 'a');

		const [song] = await listUserLibrarySongs(db, 'u1');
		expect(song?.playCount).toBe(2);
		expect(song?.lastPlayedAt).not.toBeNull();
	});

	it('does not duplicate a song that belongs to multiple of the user\'s playlists', async () => {
		await seedUser('u1');
		await seedSong('a');
		const mix1 = await createPlaylist(db, { userId: 'u1', name: 'Mix 1' });
		const mix2 = await createPlaylist(db, { userId: 'u1', name: 'Mix 2' });
		await addSongToPlaylist(db, mix1.id, 'u1', 'a');
		await addSongToPlaylist(db, mix2.id, 'u1', 'a');

		const result = await listUserLibrarySongs(db, 'u1');
		expect(result).toHaveLength(1);
	});

	it('only reflects one user\'s own play count for a song shared with another user', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await seedSong('shared');
		const p1 = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		const p2 = await createPlaylist(db, { userId: 'u2', name: 'Their Mix' });
		await addSongToPlaylist(db, p1.id, 'u1', 'shared');
		await addSongToPlaylist(db, p2.id, 'u2', 'shared');
		await recordSongPlay(db, 'u2', 'shared');
		await recordSongPlay(db, 'u2', 'shared');
		await recordSongPlay(db, 'u2', 'shared');

		const [song] = await listUserLibrarySongs(db, 'u1');
		expect(song?.playCount).toBe(0);
	});
});
