import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { users, auditLog } from '../db/schema';
import { recordAuditEvent, listAuditLog } from './log';

const db = getDb(env);

async function seedUser(id: string) {
	await db
		.insert(users)
		.values({ id, username: `user-${id}`, passwordHash: 'x' })
		.onConflictDoNothing();
}

beforeEach(async () => {
	await db.delete(auditLog);
	await db.delete(users);
});

describe('recordAuditEvent / listAuditLog', () => {
	it('records and lists a minimal event', async () => {
		await seedUser('u1');
		await recordAuditEvent(db, { actorId: 'u1', eventType: 'login' });

		const { entries, total } = await listAuditLog(db);

		expect(entries).toHaveLength(1);
		expect(total).toBe(1);
		expect(entries[0].eventType).toBe('login');
		expect(entries[0].actorId).toBe('u1');
	});

	it('serializes detail as JSON and stores null fields as null, not undefined-shaped strings', async () => {
		await seedUser('u1');
		await recordAuditEvent(db, {
			actorId: 'u1',
			eventType: 'invite_created',
			detail: { code: 'ABC123' }
		});

		const { entries } = await listAuditLog(db);
		const [entry] = entries;

		expect(JSON.parse(entry.detail!)).toEqual({ code: 'ABC123' });
		expect(entry.targetType).toBeNull();
		expect(entry.targetId).toBeNull();
	});

	it('lists most-recent-first', async () => {
		await seedUser('u1');
		await recordAuditEvent(db, { actorId: 'u1', eventType: 'login' });
		const [firstEntry] = await db.query.auditLog.findMany();
		// D1's created_at default has second-level precision — advance the
		// first row's timestamp explicitly rather than relying on two
		// inserts landing in different ticks, so this test can't flake.
		await db
			.update(auditLog)
			.set({ createdAt: '2020-01-01T00:00:00.000Z' })
			.where(eq(auditLog.id, firstEntry.id));
		await recordAuditEvent(db, { actorId: 'u1', eventType: 'invite_created' });

		const { entries } = await listAuditLog(db);

		expect(entries[0].eventType).toBe('invite_created');
	});

	it('caps the page size at the maximum even if a larger limit is requested', async () => {
		await seedUser('u1');
		for (let i = 0; i < 5; i++) {
			await recordAuditEvent(db, { actorId: 'u1', eventType: 'login' });
		}

		const { entries, total } = await listAuditLog(db, { limit: 2 });

		expect(entries).toHaveLength(2);
		expect(total).toBe(5);
	});
});
