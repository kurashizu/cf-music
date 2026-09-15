import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { users, inviteCodes } from '../db/schema';
import { register, login, resolveSession, logout, logoutAllSessions, listUsers, AuthError } from './service';

const db = getDb(env.DB);
const kv = env.SESSION_KV;

async function seedInviteCode(code: string, createdBy = 'seed-admin') {
	await db.insert(users).values({ id: createdBy, username: `admin-${createdBy}`, passwordHash: 'x', isAdmin: true }).onConflictDoNothing();
	await db.insert(inviteCodes).values({ code, createdBy });
}

async function clearAllKeys(): Promise<void> {
	const { keys } = await kv.list();
	await Promise.all(keys.map((k) => kv.delete(k.name)));
}

beforeEach(async () => {
	// D1 in the worker pool is reset between test files but not between
	// `it`s within the same file, so each test starts from a clean slate.
	await db.delete(inviteCodes);
	await db.delete(users);
	await clearAllKeys();
});

describe('register', () => {
	it('creates a user and consumes the invite code', async () => {
		await seedInviteCode('CODE1');

		const result = await register(db, {
			username: 'alice',
			password: 'hunter2-hunter2',
			inviteCode: 'CODE1'
		});

		expect(result.username).toBe('alice');

		const invite = await db.query.inviteCodes.findFirst({ where: (t, { eq }) => eq(t.code, 'CODE1') });
		expect(invite?.usedBy).toBe(result.id);
		expect(invite?.usedAt).not.toBeNull();
	});

	it('rejects a nonexistent invite code', async () => {
		await expect(
			register(db, { username: 'bob', password: 'pw', inviteCode: 'DOES-NOT-EXIST' })
		).rejects.toThrow(AuthError);
	});

	it('rejects an already-used invite code', async () => {
		await seedInviteCode('CODE2');
		await register(db, { username: 'first-user', password: 'pw', inviteCode: 'CODE2' });

		await expect(
			register(db, { username: 'second-user', password: 'pw', inviteCode: 'CODE2' })
		).rejects.toThrow(AuthError);
	});

	it('rejects a duplicate username even with a fresh invite code', async () => {
		await seedInviteCode('CODE3');
		await seedInviteCode('CODE4');
		await register(db, { username: 'carol', password: 'pw', inviteCode: 'CODE3' });

		await expect(
			register(db, { username: 'carol', password: 'different-pw', inviteCode: 'CODE4' })
		).rejects.toThrow(AuthError);
	});

	it('stores a password hash that is not the plaintext password', async () => {
		await seedInviteCode('CODE5');
		const { id } = await register(db, { username: 'dave', password: 'plaintext-pw', inviteCode: 'CODE5' });

		const user = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, id) });
		expect(user?.passwordHash).not.toBe('plaintext-pw');
		expect(user?.passwordHash.startsWith('pbkdf2$')).toBe(true);
	});
});

describe('login', () => {
	beforeEach(async () => {
		await seedInviteCode('LOGIN1');
		await register(db, { username: 'erin', password: 'correct-password', inviteCode: 'LOGIN1' });
	});

	it('succeeds with the correct password and creates a session in KV', async () => {
		const result = await login(db, kv, { username: 'erin', password: 'correct-password' });
		expect(result.sessionId).toHaveLength(64);

		const resolved = await resolveSession(db, kv, result.sessionId);
		expect(resolved.userId).toBe(result.userId);
	});

	it('rejects an incorrect password', async () => {
		await expect(login(db, kv, { username: 'erin', password: 'wrong-password' })).rejects.toThrow(AuthError);
	});

	it('rejects a nonexistent username', async () => {
		await expect(login(db, kv, { username: 'nobody', password: 'anything' })).rejects.toThrow(AuthError);
	});

	it('records the provided user agent and IP address on the session', async () => {
		const result = await login(db, kv, {
			username: 'erin',
			password: 'correct-password',
			userAgent: 'test-agent/1.0',
			ipAddress: '203.0.113.5'
		});
		const record = await kv.get<{ userAgent?: string; ipAddress?: string }>(`session:${result.sessionId}`, 'json');
		expect(record?.userAgent).toBe('test-agent/1.0');
		expect(record?.ipAddress).toBe('203.0.113.5');
	});
});

describe('resolveSession', () => {
	it('resolves an active session back to its user', async () => {
		await seedInviteCode('RESOLVE1');
		await register(db, { username: 'frank', password: 'pw12345678', inviteCode: 'RESOLVE1' });
		const { sessionId, userId } = await login(db, kv, { username: 'frank', password: 'pw12345678' });

		const resolved = await resolveSession(db, kv, sessionId);
		expect(resolved.userId).toBe(userId);
		expect(resolved.username).toBe('frank');
		expect(resolved.isAdmin).toBe(false);
	});

	it('rejects an unknown session id', async () => {
		await expect(resolveSession(db, kv, 'does-not-exist')).rejects.toThrow(AuthError);
	});

	it('rejects an expired session', async () => {
		await seedInviteCode('RESOLVE2');
		const { id: userId } = await register(db, { username: 'grace', password: 'pw12345678', inviteCode: 'RESOLVE2' });

		const expiredSessionId = 'expired-session-id';
		await kv.put(
			`session:${expiredSessionId}`,
			JSON.stringify({
				userId,
				createdAt: new Date(Date.now() - 2000).toISOString(),
				expiresAt: new Date(Date.now() - 1000).toISOString() // already in the past
			})
		);

		await expect(resolveSession(db, kv, expiredSessionId)).rejects.toThrow(AuthError);
	});
});

describe('logout', () => {
	it('removes the session so it can no longer be resolved', async () => {
		await seedInviteCode('LOGOUT1');
		await register(db, { username: 'henry', password: 'pw12345678', inviteCode: 'LOGOUT1' });
		const { sessionId } = await login(db, kv, { username: 'henry', password: 'pw12345678' });

		await logout(kv, sessionId);

		await expect(resolveSession(db, kv, sessionId)).rejects.toThrow(AuthError);
	});
});

describe('logoutAllSessions', () => {
	it('removes every session belonging to the user, leaving other users unaffected', async () => {
		await seedInviteCode('LOGOUTALL1');
		await seedInviteCode('LOGOUTALL2');
		const { id: userId } = await register(db, { username: 'iris', password: 'pw12345678', inviteCode: 'LOGOUTALL1' });
		await register(db, { username: 'jack', password: 'pw12345678', inviteCode: 'LOGOUTALL2' });

		const sessionA = await login(db, kv, { username: 'iris', password: 'pw12345678' });
		const sessionB = await login(db, kv, { username: 'iris', password: 'pw12345678' });
		const otherUserSession = await login(db, kv, { username: 'jack', password: 'pw12345678' });

		await logoutAllSessions(kv, userId);

		await expect(resolveSession(db, kv, sessionA.sessionId)).rejects.toThrow(AuthError);
		await expect(resolveSession(db, kv, sessionB.sessionId)).rejects.toThrow(AuthError);
		await expect(resolveSession(db, kv, otherUserSession.sessionId)).resolves.not.toThrow();
	});
});

describe('listUsers', () => {
	it('returns an empty array when there are no users', async () => {
		expect(await listUsers(db)).toEqual([]);
	});

	it('lists every registered user with the expected summary fields', async () => {
		// seedInviteCode's own bootstrap admin (to satisfy invite_codes'
		// created_by FK) is itself a real row in `users`, so it shows up
		// here too — assert kate's own fields rather than the list length.
		await seedInviteCode('LISTUSERS1');
		const { id } = await register(db, { username: 'kate', password: 'pw12345678', inviteCode: 'LISTUSERS1' });

		const result = await listUsers(db);

		const kate = result.find((u) => u.username === 'kate');
		expect(kate).toMatchObject({
			id,
			username: 'kate',
			isAdmin: false,
			storageQuotaBytes: 1_073_741_824,
			autoEvictEnabled: true
		});
	});

	it('lists most-recently-created first', async () => {
		await seedInviteCode('LISTUSERS2');
		await seedInviteCode('LISTUSERS3');
		const { id: liamId } = await register(db, { username: 'liam', password: 'pw12345678', inviteCode: 'LISTUSERS2' });
		const { id: miaId } = await register(db, { username: 'mia', password: 'pw12345678', inviteCode: 'LISTUSERS3' });
		// D1's created_at default has second-level precision, and
		// seedInviteCode's own bootstrap admin is a third row in this table
		// whose timestamp this test doesn't control — pin both rows under
		// test to unambiguous, known-ordered timestamps rather than relying
		// on insert order against uncontrolled real-time ticks.
		await db.update(users).set({ createdAt: '2020-01-01T00:00:00.000Z' }).where(eq(users.id, liamId));
		await db.update(users).set({ createdAt: '2020-01-02T00:00:00.000Z' }).where(eq(users.id, miaId));

		const result = await listUsers(db);
		const usernamesInOrder = result.map((u) => u.username).filter((name) => name === 'liam' || name === 'mia');

		expect(usernamesInOrder).toEqual(['mia', 'liam']);
	});
});
