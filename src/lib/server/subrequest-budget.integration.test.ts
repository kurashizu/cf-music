/**
 * How many database round trips the operations that scale with library
 * size actually make, at a realistic size.
 *
 * On a self-hosted database every round trip is a fetch, and a Worker on
 * the free plan gets 50 per invocation. Every path here once awaited one
 * query per song or per playlist, which passed against D1 (whose calls
 * have their own, larger allowance) and failed in production at the 51st
 * query. These fix a ceiling on each, well under the limit and independent
 * of how big the library is.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { getDb } from './db';
import {
	auditLog,
	embeddingJobs,
	playlists,
	playlistSongs,
	songEmbeddings,
	songs,
	userSongs,
	users
} from './db/schema';
import { countRoundTrips, SUBREQUEST_LIMIT } from '../../../test/round-trips';
import { chunk } from '../shared/chunk';
import { encodeVector } from './embedding/vector-codec';
import {
	generateSmartPlaylistsForUsers,
	USERS_PER_GENERATE_REQUEST
} from './library/smart-playlists';
import { reorderPlaylist } from './library/playlists';
import { evictSongForUser } from './eviction/execute';
import { deleteUser } from './auth/account';
import { enqueueMissingEmbeddingJobs } from './embedding/jobs';
import type { ObjectStorage } from './storage/s3';

const db = getDb(env);

const ARTISTS = 150;
const SONGS_PER_ARTIST = 2;
const EXTRA_PLAYLISTS = 40;

const storage: ObjectStorage = {
	presignGetUrl: async (key) => key,
	deleteObjects: async () => {},
	listAllKeys: async () => []
};

/** Inserts in chunks small enough for D1's bound-parameter limit. Not counted. */
async function insertAll<T extends Record<string, unknown>>(
	table: Parameters<typeof db.insert>[0],
	rows: T[],
	perStatement = 8
): Promise<void> {
	for (const part of chunk(rows, perStatement)) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await db.insert(table).values(part as any);
	}
}

function songId(userId: string, artist: number, n: number): string {
	return `${userId}-a${artist}-s${n}`;
}

/**
 * One user with the shape that broke production: a few hundred songs by a
 * hundred-odd artists (so an artist playlist each), play history on some,
 * embeddings on some, and dozens of their own playlists.
 */
async function seedHeavyUser(
	userId: string
): Promise<{ mainPlaylistId: string; videoIds: string[] }> {
	await db.insert(users).values({ id: userId, username: userId, passwordHash: 'x' });

	const videoIds: string[] = [];
	const songRows = [];
	for (let artist = 0; artist < ARTISTS; artist++) {
		for (let n = 0; n < SONGS_PER_ARTIST; n++) {
			const videoId = songId(userId, artist, n);
			videoIds.push(videoId);
			songRows.push({
				videoId,
				sourcePlatform: 'youtube',
				sourceUrl: `https://youtube.com/watch?v=${videoId}`,
				title: `Song ${videoId}`,
				artist: `Artist ${artist}`,
				audioKey: `audio/${videoId}.m4a`,
				coverKey: `covers/${videoId}.avif`,
				codec: 'opus',
				container: 'm4a',
				fileSizeBytes: 1000,
				durationSeconds: 200
			});
		}
	}
	await insertAll(songs, songRows, 5);

	const mainPlaylistId = `${userId}-main`;
	await db.insert(playlists).values({ id: mainPlaylistId, userId, name: 'Main' });
	await insertAll(
		playlistSongs,
		videoIds.map((videoId, position) => ({ playlistId: mainPlaylistId, videoId, position }))
	);

	const extra = Array.from({ length: EXTRA_PLAYLISTS }, (_, i) => ({
		id: `${userId}-p${i}`,
		userId,
		name: `Playlist ${i}`
	}));
	await insertAll(playlists, extra);
	await insertAll(
		playlistSongs,
		extra.flatMap((p, i) =>
			[0, 1, 2].map((n) => ({
				playlistId: p.id,
				videoId: videoIds[(i * 3 + n) % videoIds.length],
				position: n
			}))
		)
	);

	const recently = new Date().toISOString();
	await insertAll(
		userSongs,
		videoIds.slice(0, 60).map((videoId, i) => ({
			userId,
			videoId,
			playCount: i + 1,
			lastPlayedAt: recently
		}))
	);
	await insertAll(
		songEmbeddings,
		videoIds.slice(0, 80).map((videoId, i) => ({
			videoId,
			vector: encodeVector([Math.sin(i), Math.cos(i), (i % 7) / 7]),
			model: 'test'
		})),
		4
	);

	return { mainPlaylistId, videoIds };
}

beforeEach(async () => {
	await db.delete(auditLog);
	await db.delete(embeddingJobs);
	await db.delete(songEmbeddings);
	await db.delete(playlistSongs);
	await db.delete(userSongs);
	await db.update(users).set({ defaultPlaylistId: null });
	await db.delete(playlists);
	await db.delete(songs);
	await db.delete(users);
});

describe('round trips per request stay inside the subrequest limit', () => {
	it('regenerates a full page of users within the limit', async () => {
		await seedHeavyUser('u1');
		await seedHeavyUser('u2');
		const counted = countRoundTrips(env.DB);

		await generateSmartPlaylistsForUsers(counted.db, { limit: USERS_PER_GENERATE_REQUEST });
		const perUser = (counted.roundTrips - 1) / 2;

		// The request that serves a page pays for a user lookup, then the
		// same fixed cost per user however large each library is.
		expect(perUser).toBeLessThanOrEqual(4);
		expect(1 + USERS_PER_GENERATE_REQUEST * perUser).toBeLessThan(SUBREQUEST_LIMIT);

		const artistPlaylists = await db.select().from(playlists).where(eq(playlists.userId, 'u1'));
		// Sanity: the work was actually done, not skipped.
		expect(artistPlaylists.filter((p) => p.kind === 'auto_generated').length).toBeGreaterThan(
			ARTISTS
		);
	});

	it('deletes one song for a user with hundreds of playlists', async () => {
		const { videoIds } = await seedHeavyUser('u1');
		await generateSmartPlaylistsForUsers(db, { limit: USERS_PER_GENERATE_REQUEST });
		const counted = countRoundTrips(env.DB);

		await evictSongForUser(counted.db, storage, 'u1', videoIds[0], 'manual_delete');

		expect(counted.roundTrips).toBeLessThanOrEqual(8);
	});

	it('deletes an account with hundreds of songs and playlists', async () => {
		await db
			.insert(users)
			.values({ id: 'admin', username: 'admin', passwordHash: 'x', isAdmin: true });
		await seedHeavyUser('u1');
		await generateSmartPlaylistsForUsers(db, { limit: USERS_PER_GENERATE_REQUEST });
		const counted = countRoundTrips(env.DB);

		await deleteUser(counted.db, env.SESSION_KV, storage, { actorId: 'admin', targetUserId: 'u1' });

		expect(counted.roundTrips).toBeLessThanOrEqual(10);
	});

	it('reorders a long playlist end to end', async () => {
		const { mainPlaylistId, videoIds } = await seedHeavyUser('u1');
		const counted = countRoundTrips(env.DB);

		await reorderPlaylist(counted.db, mainPlaylistId, 'u1', [...videoIds].reverse());

		expect(counted.roundTrips).toBeLessThanOrEqual(5);
	});

	it('queues embeddings for a whole library at once', async () => {
		await seedHeavyUser('u1');
		const counted = countRoundTrips(env.DB);

		const queued = await enqueueMissingEmbeddingJobs(counted.db);

		expect(queued).toBe(ARTISTS * SONGS_PER_ARTIST);
		expect(counted.roundTrips).toBeLessThanOrEqual(3);
	});
});
