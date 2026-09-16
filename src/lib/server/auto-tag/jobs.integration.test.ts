import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../db';
import { users, songs, playlists, playlistSongs, importJobs, embeddingJobs, tagVectors } from '../db/schema';
import { createImportJob, recordSongImported, type SongImportSuccess } from '../import/jobs';
import { createPlaylist, addSongToPlaylist } from '../library/playlists';
import {
	claimAutoTagCandidates,
	getAllTagVectors,
	writeAutoTags,
	listAllUserIds,
	getUserLibraryAutoTags,
	rebuildAutoTagPlaylists,
	countAutoTagPlaylists
} from './jobs';

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

/** Seeds a bare songs row with no import job/embedding job/playlist link at all — just enough to satisfy playlist_songs' own FK when a test only cares about playlist-rebuild mechanics, not the embedding pipeline. */
async function seedBareSong(videoId: string) {
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
	it('returns every tag with its facet and embedding parsed back into a number array', async () => {
		await db.insert(tagVectors).values([
			{ tag: 'jazz', facet: 'genre', embedding: JSON.stringify([0.1, 0.2, 0.3]) },
			{ tag: 'chill', facet: 'mood', embedding: JSON.stringify([0.4, 0.5, 0.6]) }
		]);

		const vectors = await getAllTagVectors(db);

		expect(vectors.sort((a, b) => a.tag.localeCompare(b.tag))).toEqual([
			{ tag: 'chill', facet: 'mood', embedding: [0.4, 0.5, 0.6] },
			{ tag: 'jazz', facet: 'genre', embedding: [0.1, 0.2, 0.3] }
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

describe('listAllUserIds', () => {
	it('returns every user in the system', async () => {
		await seedUser('u1');
		await seedUser('u2');

		const userIds = await listAllUserIds(db);

		expect(userIds.sort()).toEqual(['u1', 'u2']);
	});

	it('returns an empty array when there are no users', async () => {
		const userIds = await listAllUserIds(db);
		expect(userIds).toEqual([]);
	});
});

describe('getUserLibraryAutoTags', () => {
	it('returns a song reachable through the user\'s own custom playlist, with its parsed autoTags', async () => {
		await seedSongWithEmbeddingStatus('a', 'done');
		await writeAutoTags(db, [{ videoId: 'a', autoTags: { jazz: 0.9 } }]);
		const { id: playlistId } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, playlistId, 'u1', 'a');

		const result = await getUserLibraryAutoTags(db, 'u1');

		expect(result).toEqual([{ videoId: 'a', autoTags: { jazz: 0.9 } }]);
	});

	it('returns null autoTags for a library song that has not been auto-tagged yet', async () => {
		await seedSongWithEmbeddingStatus('a', 'pending');
		const { id: playlistId } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, playlistId, 'u1', 'a');

		const result = await getUserLibraryAutoTags(db, 'u1');

		expect(result).toEqual([{ videoId: 'a', autoTags: null }]);
	});

	it('does not count a song only reachable through an auto_tag playlist (avoids the rebuild feeding on its own prior output)', async () => {
		await seedSongWithEmbeddingStatus('a', 'done');
		await writeAutoTags(db, [{ videoId: 'a', autoTags: { jazz: 0.9 } }]);
		// seedSongWithEmbeddingStatus's own recordSongImported call already
		// links 'a' into u1's default (custom) playlist — remove that link
		// so 'a' is reachable ONLY through the auto_tag playlist below,
		// which is the actual scenario this test means to cover.
		await db.delete(playlistSongs).where(eq(playlistSongs.videoId, 'a'));
		const [{ id: autoTagPlaylistId }] = await db
			.insert(playlists)
			.values({ userId: 'u1', name: 'jazz', type: 'auto_tag', tag: 'jazz', facet: 'genre' })
			.returning({ id: playlists.id });
		await db.insert(playlistSongs).values({ playlistId: autoTagPlaylistId, videoId: 'a', position: 0 });

		const result = await getUserLibraryAutoTags(db, 'u1');

		expect(result).toEqual([]);
	});

	it('deduplicates a song reachable through more than one of the user\'s own custom playlists', async () => {
		await seedSongWithEmbeddingStatus('a', 'done');
		await writeAutoTags(db, [{ videoId: 'a', autoTags: { jazz: 0.9 } }]);
		const { id: playlistA } = await createPlaylist(db, { userId: 'u1', name: 'A' });
		const { id: playlistB } = await createPlaylist(db, { userId: 'u1', name: 'B' });
		await addSongToPlaylist(db, playlistA, 'u1', 'a');
		await addSongToPlaylist(db, playlistB, 'u1', 'a');

		const result = await getUserLibraryAutoTags(db, 'u1');

		expect(result).toHaveLength(1);
	});
});

describe('rebuildAutoTagPlaylists / countAutoTagPlaylists', () => {
	it('creates one playlist per tag, with the right songs linked in order', async () => {
		await seedUser('u1');
		await seedBareSong('a');
		await seedBareSong('b');
		await seedBareSong('c');

		await rebuildAutoTagPlaylists(db, 'u1', [
			{ tag: 'jazz', facet: 'genre', videoIds: ['a', 'b', 'c'] }
		]);

		const [playlist] = await db.query.playlists.findMany({
			where: and(eq(playlists.userId, 'u1'), eq(playlists.type, 'auto_tag'))
		});
		expect(playlist.tag).toBe('jazz');
		expect(playlist.facet).toBe('genre');
		expect(playlist.name).toBe('jazz');

		const songRows = await db.query.playlistSongs.findMany({
			where: eq(playlistSongs.playlistId, playlist.id),
			orderBy: (t, { asc }) => asc(t.position)
		});
		expect(songRows.map((r) => r.videoId)).toEqual(['a', 'b', 'c']);
	});

	it('deletes every one of the user\'s prior auto_tag playlists before inserting the new set', async () => {
		await seedUser('u1');
		await rebuildAutoTagPlaylists(db, 'u1', [{ tag: 'jazz', facet: 'genre', videoIds: [] }]);

		await rebuildAutoTagPlaylists(db, 'u1', [{ tag: 'chill', facet: 'mood', videoIds: [] }]);

		const count = await countAutoTagPlaylists(db, 'u1');
		expect(count).toBe(1);
		const [playlist] = await db.query.playlists.findMany({
			where: and(eq(playlists.userId, 'u1'), eq(playlists.type, 'auto_tag'))
		});
		expect(playlist.tag).toBe('chill');
	});

	it('does not touch another user\'s auto_tag playlists', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await rebuildAutoTagPlaylists(db, 'u2', [{ tag: 'k-pop', facet: 'genre', videoIds: [] }]);

		await rebuildAutoTagPlaylists(db, 'u1', [{ tag: 'jazz', facet: 'genre', videoIds: [] }]);

		expect(await countAutoTagPlaylists(db, 'u1')).toBe(1);
		expect(await countAutoTagPlaylists(db, 'u2')).toBe(1);
	});

	it('does not touch the user\'s custom playlists', async () => {
		await seedUser('u1');
		const { id: customId } = await createPlaylist(db, { userId: 'u1', name: 'My Mix' });

		await rebuildAutoTagPlaylists(db, 'u1', [{ tag: 'jazz', facet: 'genre', videoIds: [] }]);

		const custom = await db.query.playlists.findFirst({ where: eq(playlists.id, customId) });
		expect(custom).not.toBeUndefined();
	});

	it('leaves zero auto_tag playlists when passed an empty set (e.g. no tag met the >=3-song threshold)', async () => {
		await seedUser('u1');
		await rebuildAutoTagPlaylists(db, 'u1', [{ tag: 'jazz', facet: 'genre', videoIds: [] }]);

		await rebuildAutoTagPlaylists(db, 'u1', []);

		expect(await countAutoTagPlaylists(db, 'u1')).toBe(0);
	});
});
