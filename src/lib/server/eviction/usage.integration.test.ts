import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { users, songs, playlists, playlistSongs, auditLog } from '../db/schema';
import { createPlaylist, addSongToPlaylist } from '../library/playlists';
import {
	getUserStorageUsageBytes,
	getUserQuotaBytes,
	setUserQuotaBytes,
	getUserEvictionCandidates
} from './usage';

const db = getDb(env.DB);

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
			codec: 'opus',
			container: 'webm',
			fileSizeBytes: 100_000,
			...overrides
		})
		.onConflictDoNothing();
}

beforeEach(async () => {
	await db.delete(auditLog);
	await db.delete(playlistSongs);
	await db.delete(playlists);
	await db.delete(songs);
	await db.delete(users);
});

describe('getUserStorageUsageBytes', () => {
	it('returns 0 for a user with no songs', async () => {
		await seedUser('u1');
		expect(await getUserStorageUsageBytes(db, 'u1')).toBe(0);
	});

	it('sums the file sizes of every distinct song across all of a user\'s playlists', async () => {
		await seedUser('u1');
		await seedSong('a', { fileSizeBytes: 100 });
		await seedSong('b', { fileSizeBytes: 250 });
		const { id: p1 } = await createPlaylist(db, { userId: 'u1', name: 'Mix 1' });
		const { id: p2 } = await createPlaylist(db, { userId: 'u1', name: 'Mix 2' });
		await addSongToPlaylist(db, p1, 'u1', 'a');
		await addSongToPlaylist(db, p2, 'u1', 'b');

		expect(await getUserStorageUsageBytes(db, 'u1')).toBe(350);
	});

	it('counts a song referenced by two of the user\'s own playlists only once', async () => {
		await seedUser('u1');
		await seedSong('a', { fileSizeBytes: 100 });
		const { id: p1 } = await createPlaylist(db, { userId: 'u1', name: 'Mix 1' });
		const { id: p2 } = await createPlaylist(db, { userId: 'u1', name: 'Mix 2' });
		await addSongToPlaylist(db, p1, 'u1', 'a');
		await addSongToPlaylist(db, p2, 'u1', 'a');

		expect(await getUserStorageUsageBytes(db, 'u1')).toBe(100);
	});

	it('does not count another user\'s playlists', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await seedSong('a', { fileSizeBytes: 100 });
		const { id } = await createPlaylist(db, { userId: 'u2', name: 'Their Mix' });
		await addSongToPlaylist(db, id, 'u2', 'a');

		expect(await getUserStorageUsageBytes(db, 'u1')).toBe(0);
	});
});

describe('getUserQuotaBytes', () => {
	it('returns the user\'s configured quota', async () => {
		await seedUser('u1', 555_000);
		expect(await getUserQuotaBytes(db, 'u1')).toBe(555_000);
	});

	it('throws for a nonexistent user', async () => {
		await expect(getUserQuotaBytes(db, 'does-not-exist')).rejects.toThrow();
	});
});

describe('setUserQuotaBytes', () => {
	it('updates the stored quota', async () => {
		await seedUser('u1', 1_000_000);
		await seedUser('admin-1');

		await setUserQuotaBytes(db, 'u1', 2_000_000, 'admin-1');

		expect(await getUserQuotaBytes(db, 'u1')).toBe(2_000_000);
	});

	it('records a quota_adjusted audit event with the before/after values', async () => {
		await seedUser('u1', 1_000_000);
		await seedUser('admin-1');

		await setUserQuotaBytes(db, 'u1', 2_000_000, 'admin-1');

		const [entry] = await db.query.auditLog.findMany();
		expect(entry.eventType).toBe('quota_adjusted');
		expect(entry.userId).toBe('u1');
		expect(entry.actorId).toBe('admin-1');
		expect(JSON.parse(entry.detail!)).toEqual({ previousQuotaBytes: 1_000_000, newQuotaBytes: 2_000_000 });
	});

	it('throws for a nonexistent user without writing an audit event', async () => {
		await seedUser('admin-1');

		await expect(setUserQuotaBytes(db, 'does-not-exist', 2_000_000, 'admin-1')).rejects.toThrow();

		expect(await db.query.auditLog.findMany()).toEqual([]);
	});
});

describe('getUserEvictionCandidates', () => {
	it('returns an empty array for a user with no songs', async () => {
		await seedUser('u1');
		expect(await getUserEvictionCandidates(db, 'u1')).toEqual([]);
	});

	it('annotates each distinct song with its scoring fields', async () => {
		await seedUser('u1');
		await seedSong('a', { fileSizeBytes: 500, playCount: 3 });
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		await addSongToPlaylist(db, id, 'u1', 'a');

		const [candidate] = await getUserEvictionCandidates(db, 'u1');

		expect(candidate.videoId).toBe('a');
		expect(candidate.fileSizeBytes).toBe(500);
		expect(candidate.playCount).toBe(3);
		expect(candidate.lastPlayedAt).toBeNull();
		expect(candidate.importedAt).toBeInstanceOf(Date);
	});
});
