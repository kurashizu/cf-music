import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { users, quotaReservations } from '../db/schema';
import { createImportJob } from './jobs';
import { reserveQuota, releaseQuotaReservation, releaseAllQuotaReservationsForJob } from './quota-reservations';

const db = getDb(env.DB);

async function seedUser(id: string, quotaBytes = 1_000_000) {
	await db
		.insert(users)
		.values({ id, username: `user-${id}`, passwordHash: 'x', storageQuotaBytes: quotaBytes })
		.onConflictDoNothing();
}

async function seedJob(userId: string): Promise<string> {
	const { id } = await createImportJob(db, { userId, sourceUrl: 'https://example.com/playlist' });
	return id;
}

beforeEach(async () => {
	await db.delete(quotaReservations);
});

describe('reserveQuota', () => {
	it('reserves successfully when the estimate fits within remaining quota', async () => {
		await seedUser('u1', 1_000_000);
		const jobId = await seedJob('u1');

		const result = await reserveQuota(db, 'u1', jobId, 'a', 500_000);

		expect(result.reserved).toBe(true);
		expect(result.remainingBytes).toBe(500_000);
	});

	it('fails to reserve when the estimate would exceed remaining quota', async () => {
		await seedUser('u1', 1_000_000);
		const jobId = await seedJob('u1');

		const result = await reserveQuota(db, 'u1', jobId, 'a', 1_500_000);

		expect(result.reserved).toBe(false);
		expect(result.remainingBytes).toBe(1_000_000);
	});

	it('accounts for existing reservations, not just committed usage, when checking fit', async () => {
		await seedUser('u1', 1_000_000);
		const jobId = await seedJob('u1');

		const first = await reserveQuota(db, 'u1', jobId, 'a', 600_000);
		expect(first.reserved).toBe(true);

		// 600,000 already reserved + 500,000 more would be 1,100,000 > 1,000,000 quota
		const second = await reserveQuota(db, 'u1', jobId, 'b', 500_000);
		expect(second.reserved).toBe(false);
		expect(second.remainingBytes).toBe(400_000);
	});

	it('allows a second reservation that fits in what the first left behind', async () => {
		await seedUser('u1', 1_000_000);
		const jobId = await seedJob('u1');

		await reserveQuota(db, 'u1', jobId, 'a', 600_000);
		const second = await reserveQuota(db, 'u1', jobId, 'b', 300_000);

		expect(second.reserved).toBe(true);
		expect(second.remainingBytes).toBe(100_000);
	});

	it('is idempotent for the same job+videoId pair (does not double-reserve on retry)', async () => {
		await seedUser('u1', 1_000_000);
		const jobId = await seedJob('u1');

		const first = await reserveQuota(db, 'u1', jobId, 'a', 500_000);
		const retry = await reserveQuota(db, 'u1', jobId, 'a', 500_000);

		expect(first.reserved).toBe(true);
		// The retry's own INSERT is a genuine conflict (same job_id +
		// video_id), so ON CONFLICT DO NOTHING means RETURNING yields zero
		// rows for it - reserved must be false here, not just "true again
		// because a row still exists from the first call". A caller
		// (download_one in import.py) branches on this boolean alone, so a
		// wrong true here would be a real bug this test needs to actually
		// catch, not just check the downstream remainingBytes number.
		expect(retry.reserved).toBe(false);
		// The row from the first call still exists - remaining quota
		// reflects one reservation, not two.
		expect(retry.remainingBytes).toBe(500_000);
	});

	it('resolves two concurrent reservations for the same user so only what actually fits gets reserved', async () => {
		await seedUser('u1', 1_000_000);
		const jobId = await seedJob('u1');

		// Two calls "at once" - each reads usage/quota independently, but
		// SQLite serializes the actual INSERT...SELECT statements, so this
		// is the real test of the race the function exists to close: both
		// requests estimate 600,000 bytes each (1,200,000 together, over
		// the 1,000,000 quota), and only one should win.
		const [a, b] = await Promise.all([
			reserveQuota(db, 'u1', jobId, 'a', 600_000),
			reserveQuota(db, 'u1', jobId, 'b', 600_000)
		]);

		const reservedCount = [a.reserved, b.reserved].filter(Boolean).length;
		expect(reservedCount).toBe(1);
	});

	it('scopes reservations per user — another user\'s reservations do not affect this one\'s remaining quota', async () => {
		await seedUser('u1', 1_000_000);
		await seedUser('u2', 1_000_000);
		const jobU2 = await seedJob('u2');
		await reserveQuota(db, 'u2', jobU2, 'shared-video', 900_000);

		const jobU1 = await seedJob('u1');
		const result = await reserveQuota(db, 'u1', jobU1, 'a', 900_000);

		expect(result.reserved).toBe(true);
	});
});

describe('releaseQuotaReservation', () => {
	it('frees up the reserved bytes for a subsequent reservation', async () => {
		await seedUser('u1', 1_000_000);
		const jobId = await seedJob('u1');
		await reserveQuota(db, 'u1', jobId, 'a', 900_000);

		await releaseQuotaReservation(db, jobId, 'a');

		const result = await reserveQuota(db, 'u1', jobId, 'b', 900_000);
		expect(result.reserved).toBe(true);
	});

	it('is a no-op for a reservation that does not exist', async () => {
		await seedUser('u1');
		const jobId = await seedJob('u1');
		await expect(releaseQuotaReservation(db, jobId, 'never-reserved')).resolves.not.toThrow();
	});

	it('only releases the specified videoId, leaving other reservations in the same job intact', async () => {
		await seedUser('u1', 1_000_000);
		const jobId = await seedJob('u1');
		await reserveQuota(db, 'u1', jobId, 'a', 400_000);
		await reserveQuota(db, 'u1', jobId, 'b', 400_000);

		await releaseQuotaReservation(db, jobId, 'a');

		// Only 400,000 (b) should still be reserved, so 500,000 more should fit under a 1,000,000 quota.
		const result = await reserveQuota(db, 'u1', jobId, 'c', 500_000);
		expect(result.reserved).toBe(true);
	});
});

describe('releaseAllQuotaReservationsForJob', () => {
	it('releases every reservation held by the job at once', async () => {
		await seedUser('u1', 1_000_000);
		const jobId = await seedJob('u1');
		await reserveQuota(db, 'u1', jobId, 'a', 400_000);
		await reserveQuota(db, 'u1', jobId, 'b', 400_000);

		await releaseAllQuotaReservationsForJob(db, jobId);

		const result = await reserveQuota(db, 'u1', jobId, 'c', 1_000_000);
		expect(result.reserved).toBe(true);
	});

	it('does not affect reservations held by a different job', async () => {
		await seedUser('u1', 1_000_000);
		const jobA = await seedJob('u1');
		const jobB = await seedJob('u1');
		await reserveQuota(db, 'u1', jobA, 'a', 400_000);
		await reserveQuota(db, 'u1', jobB, 'b', 400_000);

		await releaseAllQuotaReservationsForJob(db, jobA);

		// jobB's 400,000 reservation should still be counted.
		const result = await reserveQuota(db, 'u1', jobA, 'c', 700_000);
		expect(result.reserved).toBe(false);
	});
});
