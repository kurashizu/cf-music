import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../db';
import { users, songs, userSongs } from '../db/schema';
import { recordSongPlay } from './plays';
import { setCachePreference } from '../cache/preferences';

const db = getDb(env.DB);

async function seedUser(id: string) {
	await db.insert(users).values({ id, username: `user-${id}`, passwordHash: 'x' }).onConflictDoNothing();
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
			fileSizeBytes: 100_000
		})
		.onConflictDoNothing();
}

beforeEach(async () => {
	await db.delete(userSongs);
	await db.delete(songs);
	await db.delete(users);
});

describe('recordSongPlay', () => {
	it('creates a row with playCount 1 on the first play', async () => {
		await seedUser('u1');
		await seedSong('a');

		await recordSongPlay(db, 'u1', 'a');

		const row = await db.query.userSongs.findFirst({ where: and(eq(userSongs.userId, 'u1'), eq(userSongs.videoId, 'a')) });
		expect(row?.playCount).toBe(1);
		expect(row?.lastPlayedAt).not.toBeNull();
	});

	it('increments playCount on subsequent plays rather than overwriting it', async () => {
		await seedUser('u1');
		await seedSong('a');

		await recordSongPlay(db, 'u1', 'a');
		await recordSongPlay(db, 'u1', 'a');
		await recordSongPlay(db, 'u1', 'a');

		const row = await db.query.userSongs.findFirst({ where: and(eq(userSongs.userId, 'u1'), eq(userSongs.videoId, 'a')) });
		expect(row?.playCount).toBe(3);
	});

	it('keeps separate play counts per user for the same shared song', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await seedSong('shared');

		await recordSongPlay(db, 'u1', 'shared');
		await recordSongPlay(db, 'u2', 'shared');
		await recordSongPlay(db, 'u2', 'shared');

		const u1Row = await db.query.userSongs.findFirst({ where: and(eq(userSongs.userId, 'u1'), eq(userSongs.videoId, 'shared')) });
		const u2Row = await db.query.userSongs.findFirst({ where: and(eq(userSongs.userId, 'u2'), eq(userSongs.videoId, 'shared')) });
		expect(u1Row?.playCount).toBe(1);
		expect(u2Row?.playCount).toBe(2);
	});

	it('resolves two concurrent plays for the same user/song into a correct total, not a lost update', async () => {
		await seedUser('u1');
		await seedSong('a');

		// Two "simultaneous" plays racing the same upsert — SQLite serializes
		// the actual writes, so this is the real test that the conflict
		// clause's `+ 1` reads the already-serialized row rather than a
		// value captured before either write landed.
		await Promise.all([recordSongPlay(db, 'u1', 'a'), recordSongPlay(db, 'u1', 'a')]);

		const row = await db.query.userSongs.findFirst({ where: and(eq(userSongs.userId, 'u1'), eq(userSongs.videoId, 'a')) });
		expect(row?.playCount).toBe(2);
	});

	it('does not clobber an existing cache_type when recording a play on an already-pinned song', async () => {
		await seedUser('u1');
		await seedSong('a');
		await setCachePreference(db, 'u1', 'a', 'pinned');

		await recordSongPlay(db, 'u1', 'a');

		const row = await db.query.userSongs.findFirst({ where: and(eq(userSongs.userId, 'u1'), eq(userSongs.videoId, 'a')) });
		expect(row?.playCount).toBe(1);
		expect(row?.cacheType).toBe('pinned');
	});
});
