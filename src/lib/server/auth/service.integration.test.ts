import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { users, inviteCodes, sessions } from '../db/schema';
import { register, login, resolveSession, logout, logoutAllSessions, AuthError } from './service';

const db = getDb(env.DB);

async function seedInviteCode(code: string, createdBy = 'seed-admin') {
	await db.insert(users).values({ id: createdBy, username: `admin-${createdBy}`, passwordHash: 'x', isAdmin: true }).onConflictDoNothing();
	await db.insert(inviteCodes).values({ code, createdBy });
}

beforeEach(async () => {
	// D1 in the worker pool is reset between test files but not between
	// `it`s within the same file, so each test starts from a clean slate.
	await db.delete(sessions);
	await db.delete(inviteCodes);
	await db.delete(users);
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

	it('succeeds with the correct password and creates a session row', async () => {
		const result = await login(db, { username: 'erin', password: 'correct-password' });
		expect(result.sessionId).toHaveLength(64);

		const session = await db.query.sessions.findFirst({ where: (t, { eq }) => eq(t.id, result.sessionId) });
		expect(session).not.toBeUndefined();
		expect(session?.userId).toBe(result.userId);
	});

	it('rejects an incorrect password', async () => {
		await expect(login(db, { username: 'erin', password: 'wrong-password' })).rejects.toThrow(AuthError);
	});

	it('rejects a nonexistent username', async () => {
		await expect(login(db, { username: 'nobody', password: 'anything' })).rejects.toThrow(AuthError);
	});

	it('records the provided user agent and IP address on the session', async () => {
		const result = await login(db, {
			username: 'erin',
			password: 'correct-password',
			userAgent: 'test-agent/1.0',
			ipAddress: '203.0.113.5'
		});
		const session = await db.query.sessions.findFirst({ where: (t, { eq }) => eq(t.id, result.sessionId) });
		expect(session?.userAgent).toBe('test-agent/1.0');
		expect(session?.ipAddress).toBe('203.0.113.5');
	});
});

describe('resolveSession', () => {
	it('resolves an active session back to its user', async () => {
		await seedInviteCode('RESOLVE1');
		await register(db, { username: 'frank', password: 'pw12345678', inviteCode: 'RESOLVE1' });
		const { sessionId, userId } = await login(db, { username: 'frank', password: 'pw12345678' });

		const resolved = await resolveSession(db, sessionId);
		expect(resolved.userId).toBe(userId);
		expect(resolved.username).toBe('frank');
		expect(resolved.isAdmin).toBe(false);
	});

	it('rejects an unknown session id', async () => {
		await expect(resolveSession(db, 'does-not-exist')).rejects.toThrow(AuthError);
	});

	it('rejects an expired session', async () => {
		await seedInviteCode('RESOLVE2');
		const { id: userId } = await register(db, { username: 'grace', password: 'pw12345678', inviteCode: 'RESOLVE2' });

		const expiredSessionId = 'expired-session-id';
		await db.insert(sessions).values({
			id: expiredSessionId,
			userId,
			expiresAt: new Date(Date.now() - 1000).toISOString() // already in the past
		});

		await expect(resolveSession(db, expiredSessionId)).rejects.toThrow(AuthError);
	});
});

describe('logout', () => {
	it('removes the session so it can no longer be resolved', async () => {
		await seedInviteCode('LOGOUT1');
		await register(db, { username: 'henry', password: 'pw12345678', inviteCode: 'LOGOUT1' });
		const { sessionId } = await login(db, { username: 'henry', password: 'pw12345678' });

		await logout(db, sessionId);

		await expect(resolveSession(db, sessionId)).rejects.toThrow(AuthError);
	});
});

describe('logoutAllSessions', () => {
	it('removes every session belonging to the user, leaving other users unaffected', async () => {
		await seedInviteCode('LOGOUTALL1');
		await seedInviteCode('LOGOUTALL2');
		const { id: userId } = await register(db, { username: 'iris', password: 'pw12345678', inviteCode: 'LOGOUTALL1' });
		await register(db, { username: 'jack', password: 'pw12345678', inviteCode: 'LOGOUTALL2' });

		const sessionA = await login(db, { username: 'iris', password: 'pw12345678' });
		const sessionB = await login(db, { username: 'iris', password: 'pw12345678' });
		const otherUserSession = await login(db, { username: 'jack', password: 'pw12345678' });

		await logoutAllSessions(db, userId);

		await expect(resolveSession(db, sessionA.sessionId)).rejects.toThrow(AuthError);
		await expect(resolveSession(db, sessionB.sessionId)).rejects.toThrow(AuthError);
		await expect(resolveSession(db, otherUserSession.sessionId)).resolves.not.toThrow();
	});
});
