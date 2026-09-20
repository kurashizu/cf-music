import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { users, songs, playlists, importJobs, auditLog } from '../db/schema';
import { eq } from 'drizzle-orm';
import {
	createImportJob,
	getImportJob,
	listImportJobs,
	startImportJob,
	recordSongImported,
	recordKnownSongLinked,
	recordSongFailed,
	completeImportJob,
	failImportJob,
	disconnectImportJob,
	findKnownVideoIds,
	submitImportPreview,
	cancelImportJob,
	failStaleImportJobs,
	ImportJobError,
	type SongImportSuccess
} from './jobs';
import { reserveQuota } from './quota-reservations';
import {
	getPlaylistMeta,
	getPlaylistSongsInRange,
	createPlaylist,
	ensureDefaultPlaylist,
	type PlaylistSongRow
} from '../library/playlists';

const db = getDb(env.DB);

// Test-only convenience — see the same helper's comment in
// playlists.integration.test.ts for why this composes the two real,
// separately-paginated functions rather than a production-only full fetch.
async function fetchWholePlaylist(
	playlistId: string,
	userId: string
): Promise<{ songs: PlaylistSongRow[] }> {
	const meta = await getPlaylistMeta(db, playlistId, userId);
	const songs = await getPlaylistSongsInRange(
		db,
		playlistId,
		userId,
		0,
		Math.max(meta.songCount, 1)
	);
	return { songs };
}

async function seedUser(id: string, quotaBytes = 1_073_741_824) {
	await db
		.insert(users)
		.values({ id, username: `user-${id}`, passwordHash: 'x', storageQuotaBytes: quotaBytes })
		.onConflictDoNothing();
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

beforeEach(async () => {
	// defaultPlaylistId references playlists.id (see schema.ts) — clear it
	// before deleting playlists/users, or a user left with a default from
	// a previous test violates that foreign key.
	await db.update(users).set({ defaultPlaylistId: null });
	await db.delete(importJobs);
	await db.delete(playlists);
	await db.delete(songs);
	await db.delete(users);
});

describe('createImportJob / getImportJob', () => {
	it('creates a job in pending status', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, {
			userId: 'u1',
			sourceUrl: 'https://youtube.com/playlist?list=x'
		});

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('pending');
		expect(job.completedCount).toBe(0);
		expect(job.failedCount).toBe(0);
	});

	it('throws not_found for a job belonging to a different user', async () => {
		await seedUser('u1');
		await seedUser('u2');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await expect(getImportJob(db, id, 'u2')).rejects.toThrow(ImportJobError);
	});
});

describe('startImportJob', () => {
	it('transitions to running and records the expected total', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await startImportJob(db, id, 5);

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('running');
		expect(job.totalCount).toBe(5);
	});
});

describe('recordSongImported', () => {
	it('creates the song row and increments completedCount', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await recordSongImported(db, id, 'u1', makeSong('a'));

		const job = await getImportJob(db, id, 'u1');
		expect(job.completedCount).toBe(1);
		const song = await db.query.songs.findFirst({ where: eq(songs.videoId, 'a') });
		expect(song).not.toBeUndefined();
	});

	it('links the song into the target playlist when the job has one', async () => {
		await seedUser('u1');
		await db.insert(playlists).values({ id: 'p1', userId: 'u1', name: 'Imported' });
		const { id } = await createImportJob(db, {
			userId: 'u1',
			sourceUrl: 'https://x',
			targetPlaylistId: 'p1'
		});

		await recordSongImported(db, id, 'u1', makeSong('a'));

		const playlist = await fetchWholePlaylist('p1', 'u1');
		expect(playlist.songs.map((s) => s.videoId)).toEqual(['a']);
	});

	it('always links the song into the default playlist too, even with a different explicit target', async () => {
		await seedUser('u1');
		const { id: defaultPlaylistId } = await ensureDefaultPlaylist(db, 'u1');
		await db.insert(playlists).values({ id: 'p1', userId: 'u1', name: 'Imported' });
		const { id } = await createImportJob(db, {
			userId: 'u1',
			sourceUrl: 'https://x',
			targetPlaylistId: 'p1'
		});

		await recordSongImported(db, id, 'u1', makeSong('a'));

		const targetPlaylist = await fetchWholePlaylist('p1', 'u1');
		const defaultPlaylist = await fetchWholePlaylist(defaultPlaylistId, 'u1');
		expect(targetPlaylist.songs.map((s) => s.videoId)).toEqual(['a']);
		expect(defaultPlaylist.songs.map((s) => s.videoId)).toEqual(['a']);
	});

	it('does not double-link when the explicit target is already the default playlist', async () => {
		await seedUser('u1');
		const { id: defaultPlaylistId } = await ensureDefaultPlaylist(db, 'u1');
		const { id } = await createImportJob(db, {
			userId: 'u1',
			sourceUrl: 'https://x',
			targetPlaylistId: defaultPlaylistId
		});

		await recordSongImported(db, id, 'u1', makeSong('a'));

		const defaultPlaylist = await fetchWholePlaylist(defaultPlaylistId, 'u1');
		expect(defaultPlaylist.songs.map((s) => s.videoId)).toEqual(['a']);
	});

	it('does not fail when the video_id was already imported by someone else (dedup reuse)', async () => {
		await seedUser('u1');
		await seedUser('u2');
		const { tags: _tags, ...seedRow } = makeSong('shared');
		await db.insert(songs).values(seedRow);
		const { id } = await createImportJob(db, { userId: 'u2', sourceUrl: 'https://x' });

		await expect(
			recordSongImported(db, id, 'u2', makeSong('shared', { title: 'Different title' }))
		).resolves.not.toThrow();

		// The pre-existing row's data is preserved, not overwritten by the duplicate import.
		const song = await db.query.songs.findFirst({ where: eq(songs.videoId, 'shared') });
		expect(song?.title).toBe('Song shared');
	});

	it('throws not_found for a job belonging to a different user', async () => {
		await seedUser('u1');
		await seedUser('u2');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await expect(recordSongImported(db, id, 'u2', makeSong('a'))).rejects.toThrow(ImportJobError);
	});

	it("releases the song's quota reservation once it lands as real usage", async () => {
		await seedUser('u1', 2_000_000);
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await reserveQuota(db, 'u1', id, 'a', 900_000);

		await recordSongImported(db, id, 'u1', makeSong('a', { fileSizeBytes: 900_000 }));

		// The reservation itself is gone (it's real usage now, not a
		// reservation) — a second song's reservation for the same bytes
		// should succeed as long as it still fits the quota alongside the
		// first song's now-real 900_000 bytes of usage. (The first song is
		// always linked into the user's default playlist regardless of
		// this job's own target — see linkImportedSongToLibrary — so it
		// counts as real usage, unlike before that link existed.)
		const result = await reserveQuota(db, 'u1', id, 'b', 900_000);
		expect(result.reserved).toBe(true);
	});
});

describe('recordKnownSongLinked', () => {
	it("links an already-existing song into the job's target playlist", async () => {
		await seedUser('u1');
		const { tags: _tags, ...seedRow } = makeSong('already-owned');
		await db.insert(songs).values(seedRow);
		const { id: playlistId } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		const { id: jobId } = await createImportJob(db, {
			userId: 'u1',
			sourceUrl: 'https://x',
			targetPlaylistId: playlistId
		});

		await recordKnownSongLinked(db, jobId, 'u1', 'already-owned');

		const playlist = await fetchWholePlaylist(playlistId, 'u1');
		expect(playlist.songs.map((s) => s.videoId)).toEqual(['already-owned']);
	});

	it('increments knownCount, not completedCount', async () => {
		await seedUser('u1');
		const { tags: _tags, ...seedRow } = makeSong('already-owned');
		await db.insert(songs).values(seedRow);
		const { id: playlistId } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		const { id: jobId } = await createImportJob(db, {
			userId: 'u1',
			sourceUrl: 'https://x',
			targetPlaylistId: playlistId
		});

		await recordKnownSongLinked(db, jobId, 'u1', 'already-owned');

		const job = await getImportJob(db, jobId, 'u1');
		expect(job.knownCount).toBe(1);
		expect(job.completedCount).toBe(0);
	});

	it('does not touch the songs table itself — no write for a row that already exists', async () => {
		await seedUser('u1');
		const { tags: _tags, ...seedRow } = makeSong('already-owned', { title: 'Original Title' });
		await db.insert(songs).values(seedRow);
		const { id: playlistId } = await createPlaylist(db, { userId: 'u1', name: 'Mix' });
		const { id: jobId } = await createImportJob(db, {
			userId: 'u1',
			sourceUrl: 'https://x',
			targetPlaylistId: playlistId
		});

		await recordKnownSongLinked(db, jobId, 'u1', 'already-owned');

		const song = await db.query.songs.findFirst({ where: eq(songs.videoId, 'already-owned') });
		expect(song?.title).toBe('Original Title');
	});

	it('is a no-op for the playlist link if the job has no target playlist, but still counts toward knownCount', async () => {
		await seedUser('u1');
		const { tags: _tags, ...seedRow } = makeSong('already-owned');
		await db.insert(songs).values(seedRow);
		const { id: jobId } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await expect(recordKnownSongLinked(db, jobId, 'u1', 'already-owned')).resolves.not.toThrow();

		const job = await getImportJob(db, jobId, 'u1');
		expect(job.knownCount).toBe(1);
	});
});

describe('recordSongFailed', () => {
	it('increments failedCount and appends to the failures list', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await recordSongFailed(db, id, 'u1', { videoId: 'bad1', reason: 'video unavailable' });
		await recordSongFailed(db, id, 'u1', { videoId: 'bad2', reason: 'no audio track' });

		const job = await getImportJob(db, id, 'u1');
		expect(job.failedCount).toBe(2);
		expect(JSON.parse(job.failures!)).toEqual([
			{ videoId: 'bad1', reason: 'video unavailable' },
			{ videoId: 'bad2', reason: 'no audio track' }
		]);
	});

	it("releases the failed song's quota reservation", async () => {
		await seedUser('u1', 1_000_000);
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await reserveQuota(db, 'u1', id, 'a', 900_000);

		await recordSongFailed(db, id, 'u1', { videoId: 'a', reason: 'download failed' });

		const result = await reserveQuota(db, 'u1', id, 'b', 900_000);
		expect(result.reserved).toBe(true);
	});
});

describe('completeImportJob', () => {
	it('marks the job completed when at least one song succeeded, even with some failures', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordSongImported(db, id, 'u1', makeSong('a'));
		await recordSongFailed(db, id, 'u1', { videoId: 'bad', reason: 'error' });

		await completeImportJob(db, id, 'u1');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('completed');
		expect(job.completedAt).not.toBeNull();
	});

	it('marks the job failed when every song failed and none succeeded', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordSongFailed(db, id, 'u1', { videoId: 'bad', reason: 'error' });

		await completeImportJob(db, id, 'u1');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('failed');
	});

	it('marks the job completed when everything succeeded with zero failures', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordSongImported(db, id, 'u1', makeSong('a'));

		await completeImportJob(db, id, 'u1');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('completed');
	});

	it('marks the job completed when a known (skipped) song landed, even with some failures and zero real downloads', async () => {
		await seedUser('u1');
		const { tags: _tags, ...seedRow } = makeSong('already-owned');
		await db.insert(songs).values(seedRow);
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordKnownSongLinked(db, id, 'u1', 'already-owned');
		await recordSongFailed(db, id, 'u1', { videoId: 'bad', reason: 'error' });

		await completeImportJob(db, id, 'u1');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('completed');
	});

	it('records an audit event once the job reaches a terminal status', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordSongImported(db, id, 'u1', makeSong('a'));

		await completeImportJob(db, id, 'u1');

		const [entry] = await db.query.auditLog.findMany({ where: eq(auditLog.targetId, id) });
		expect(entry.eventType).toBe('import');
		expect(entry.targetType).toBe('import_job');
		expect(JSON.parse(entry.detail!)).toMatchObject({ status: 'completed' });
	});
});

describe('failImportJob', () => {
	it('marks the job failed and records the reason', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await failImportJob(db, id, 'u1', 'yt-dlp could not extract the source URL');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('failed');
		expect(job.fatalError).toBe('yt-dlp could not extract the source URL');
		expect(job.completedAt).not.toBeNull();
	});

	it('does not overwrite a cancelled status', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await cancelImportJob(db, id, 'u1');

		await failImportJob(db, id, 'u1', 'too late, already cancelled');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('cancelled');
	});

	it('records an audit event with the failure reason', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await failImportJob(db, id, 'u1', 'network unreachable');

		const [entry] = await db.query.auditLog.findMany({ where: eq(auditLog.targetId, id) });
		expect(entry.eventType).toBe('import');
		expect(entry.targetType).toBe('import_job');
		expect(JSON.parse(entry.detail!)).toMatchObject({
			status: 'failed',
			reason: 'network unreachable'
		});
	});

	it('releases every reservation the job was still holding — an abandoned reservation must not linger', async () => {
		await seedUser('u1', 1_000_000);
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await reserveQuota(db, 'u1', id, 'a', 900_000);

		await failImportJob(db, id, 'u1', 'CI process disconnected unexpectedly');

		const secondJob = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://y' });
		const result = await reserveQuota(db, 'u1', secondJob.id, 'b', 900_000);
		expect(result.reserved).toBe(true);
	});
});

describe('disconnectImportJob', () => {
	it('marks the job failed when nothing had succeeded yet — same as a real fatal_error', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await disconnectImportJob(db, id, 'u1', 'Import process disconnected unexpectedly');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('failed');
		expect(job.fatalError).toBe('Import process disconnected unexpectedly');
	});

	it('marks the job completed, not failed, when at least one song had already succeeded', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordSongImported(db, id, 'u1', makeSong('a'));

		await disconnectImportJob(db, id, 'u1', 'Import process disconnected unexpectedly');

		const job = await getImportJob(db, id, 'u1');
		// The real-world case this exists for: a batch that fully succeeded
		// before CI's own connection happened to drop on its way to sending
		// `complete` must not show up as an outright failure when every song
		// the user asked for is already sitting in their library.
		expect(job.status).toBe('completed');
	});

	it('marks the job completed, not failed, when at least one song was already known (skipped)', async () => {
		await seedUser('u1');
		const { tags: _tags, ...seedRow } = makeSong('already-owned');
		await db.insert(songs).values(seedRow);
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordKnownSongLinked(db, id, 'u1', 'already-owned');

		await disconnectImportJob(db, id, 'u1', 'Import process disconnected unexpectedly');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('completed');
	});

	it('does not overwrite a cancelled status', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await cancelImportJob(db, id, 'u1');

		await disconnectImportJob(db, id, 'u1', 'Import process disconnected unexpectedly');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('cancelled');
	});

	it('does not overwrite an already-completed status', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordSongImported(db, id, 'u1', makeSong('a'));
		await completeImportJob(db, id, 'u1');

		await disconnectImportJob(db, id, 'u1', 'Import process disconnected unexpectedly');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('completed');
	});
});

describe('findKnownVideoIds', () => {
	it('returns an empty array for an empty input', async () => {
		expect(await findKnownVideoIds(db, [])).toEqual([]);
	});

	it('returns an empty array when none of the given ids exist', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordSongImported(db, id, 'u1', makeSong('known-1'));

		expect(await findKnownVideoIds(db, ['unrelated-1', 'unrelated-2'])).toEqual([]);
	});

	it('returns only the subset of given ids that already exist', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await recordSongImported(db, id, 'u1', makeSong('known-1'));
		await recordSongImported(db, id, 'u1', makeSong('known-2'));

		const result = await findKnownVideoIds(db, ['known-1', 'new-1', 'known-2', 'new-2']);

		expect(result.sort()).toEqual(['known-1', 'known-2']);
	});

	it('batches lookups so a list larger than the per-query chunk size is still handled correctly', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		// Larger than KNOWN_VIDEO_IDS_BATCH_SIZE (90) to exercise the chunking path.
		const knownIds = Array.from({ length: 110 }, (_, i) => `batch-known-${i}`);
		for (const videoId of knownIds) {
			await recordSongImported(db, id, 'u1', makeSong(videoId));
		}

		const requested = [...knownIds, 'batch-new-1', 'batch-new-2'];
		const result = await findKnownVideoIds(db, requested);

		expect(result.length).toBe(knownIds.length);
		expect(new Set(result)).toEqual(new Set(knownIds));
	});
});

describe('submitImportPreview', () => {
	it('stores the preview entries without changing status (informational only, no confirmation gate)', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await submitImportPreview(db, id, [
			{ videoId: 'a', title: 'Song A', durationSeconds: 120 },
			{ videoId: 'b', title: 'Song B' }
		]);

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('pending');
		expect(job.totalCount).toBe(2);
		expect(JSON.parse(job.previewEntries!)).toEqual([
			{ videoId: 'a', title: 'Song A', durationSeconds: 120 },
			{ videoId: 'b', title: 'Song B' }
		]);
	});
});

describe('cancelImportJob', () => {
	it('cancels a job still pending (e.g. the GitHub Actions dispatch itself failed)', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await cancelImportJob(db, id, 'u1');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('cancelled');
	});

	it('cancels a running job', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await startImportJob(db, id, 3);

		await cancelImportJob(db, id, 'u1');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('cancelled');
	});

	it('cancels a job that has a preview but has not started downloading yet', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await submitImportPreview(db, id, [{ videoId: 'a', title: 'Song A' }]);

		await cancelImportJob(db, id, 'u1');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('cancelled');
	});

	it('dismisses a failed job (same action as cancel — nothing left running to stop)', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await failImportJob(db, id, 'u1', 'boom');

		await cancelImportJob(db, id, 'u1');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('cancelled');
	});

	it('throws invalid_transition for a job that already completed', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await completeImportJob(db, id, 'u1');

		await expect(cancelImportJob(db, id, 'u1')).rejects.toThrow(ImportJobError);
	});

	it('records an audit event', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });

		await cancelImportJob(db, id, 'u1');

		const [entry] = await db.query.auditLog.findMany({ where: eq(auditLog.targetId, id) });
		expect(entry.eventType).toBe('import');
		expect(entry.targetType).toBe('import_job');
		expect(JSON.parse(entry.detail!)).toMatchObject({ status: 'cancelled' });
	});

	it('releases every reservation held by an in-flight download the user cancelled', async () => {
		await seedUser('u1', 1_000_000);
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await startImportJob(db, id, 2);
		await reserveQuota(db, 'u1', id, 'a', 900_000);

		await cancelImportJob(db, id, 'u1');

		const secondJob = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://y' });
		const result = await reserveQuota(db, 'u1', secondJob.id, 'b', 900_000);
		expect(result.reserved).toBe(true);
	});
});

describe('completeImportJob after cancellation', () => {
	it('does not overwrite a cancelled status with completed/failed', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x' });
		await startImportJob(db, id, 1);
		await recordSongImported(db, id, 'u1', makeSong('a'));
		await cancelImportJob(db, id, 'u1');

		await completeImportJob(db, id, 'u1');

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('cancelled');
	});
});

describe('listImportJobs', () => {
	it('returns an empty array for a user with no jobs', async () => {
		await seedUser('u1');
		expect(await listImportJobs(db, 'u1')).toEqual([]);
	});

	it('only returns jobs belonging to the given user', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x/1' });
		await createImportJob(db, { userId: 'u2', sourceUrl: 'https://x/2' });

		const jobs = await listImportJobs(db, 'u1');

		expect(jobs).toHaveLength(1);
		expect(jobs[0].sourceUrl).toBe('https://x/1');
	});

	it('orders jobs most-recently-created first', async () => {
		await seedUser('u1');
		const { id: firstId } = await createImportJob(db, {
			userId: 'u1',
			sourceUrl: 'https://x/first'
		});
		// D1's created_at default has second-level precision — advance it
		// explicitly rather than relying on two inserts landing in different
		// ticks, so this test can't flake on ordering.
		await db
			.update(importJobs)
			.set({ createdAt: '2020-01-01T00:00:00.000Z' })
			.where(eq(importJobs.id, firstId));
		const { id: secondId } = await createImportJob(db, {
			userId: 'u1',
			sourceUrl: 'https://x/second'
		});
		await db
			.update(importJobs)
			.set({ createdAt: '2020-01-02T00:00:00.000Z' })
			.where(eq(importJobs.id, secondId));

		const jobs = await listImportJobs(db, 'u1');

		expect(jobs.map((j) => j.sourceUrl)).toEqual(['https://x/second', 'https://x/first']);
	});

	it('excludes completed and cancelled jobs, which need no further explanation', async () => {
		await seedUser('u1');
		const { id: completedId } = await createImportJob(db, {
			userId: 'u1',
			sourceUrl: 'https://x/done'
		});
		await completeImportJob(db, completedId, 'u1');
		const { id: cancelledId } = await createImportJob(db, {
			userId: 'u1',
			sourceUrl: 'https://x/cancelled'
		});
		await cancelImportJob(db, cancelledId, 'u1');
		await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x/still-running' });

		const jobs = await listImportJobs(db, 'u1');

		expect(jobs.map((j) => j.sourceUrl)).toEqual(['https://x/still-running']);
	});

	it('includes failed jobs, so the user can actually see why one failed', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x/failed' });
		await failImportJob(db, id, 'u1', 'boom');

		const jobs = await listImportJobs(db, 'u1');

		expect(jobs.map((j) => j.sourceUrl)).toEqual(['https://x/failed']);
	});
});

describe('failStaleImportJobs', () => {
	it('fails a pending job whose CI socket never connected at all (no progress since creation)', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x/stuck' });
		// No startImportJob/submitImportPreview ever ran — updated_at still
		// reflects insert time, same as a real workflow_dispatch that was
		// accepted by GitHub but never actually started a runner.
		await db
			.update(importJobs)
			.set({ updatedAt: '2020-01-01 00:00:00' })
			.where(eq(importJobs.id, id));

		const failedCount = await failStaleImportJobs(db, 60 * 60 * 1000);

		expect(failedCount).toBe(1);
		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('failed');
		expect(job.fatalError).toMatch(/timed out/i);
	});

	it('fails a running job that stalled mid-import with no recent progress', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x/stalled' });
		await startImportJob(db, id, 5);
		await db
			.update(importJobs)
			.set({ updatedAt: '2020-01-01 00:00:00' })
			.where(eq(importJobs.id, id));

		await failStaleImportJobs(db, 60 * 60 * 1000);

		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('failed');
	});

	it('leaves a recently-updated job alone', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x/fresh' });
		await startImportJob(db, id, 5);

		const failedCount = await failStaleImportJobs(db, 60 * 60 * 1000);

		expect(failedCount).toBe(0);
		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('running');
	});

	it('does not touch a job that already completed', async () => {
		await seedUser('u1');
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x/done' });
		await recordSongImported(db, id, 'u1', makeSong('a'));
		await completeImportJob(db, id, 'u1');
		await db
			.update(importJobs)
			.set({ updatedAt: '2020-01-01 00:00:00' })
			.where(eq(importJobs.id, id));

		const failedCount = await failStaleImportJobs(db, 60 * 60 * 1000);

		expect(failedCount).toBe(0);
		const job = await getImportJob(db, id, 'u1');
		expect(job.status).toBe('completed');
	});

	it('releases quota reservations abandoned by a stale job', async () => {
		await seedUser('u1', 1_000_000);
		const { id } = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://x/stuck' });
		await reserveQuota(db, 'u1', id, 'a', 900_000);
		await db
			.update(importJobs)
			.set({ updatedAt: '2020-01-01 00:00:00' })
			.where(eq(importJobs.id, id));

		await failStaleImportJobs(db, 60 * 60 * 1000);

		const secondJob = await createImportJob(db, { userId: 'u1', sourceUrl: 'https://y' });
		const result = await reserveQuota(db, 'u1', secondJob.id, 'b', 900_000);
		expect(result.reserved).toBe(true);
	});
});
