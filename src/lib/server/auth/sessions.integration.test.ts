import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createSession, getSession, deleteSession, deleteAllSessionsForUser } from './sessions';

const kv = env.SESSION_KV;

function makeRecord(userId: string) {
	return {
		userId,
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString()
	};
}

async function clearAllKeys(): Promise<void> {
	const { keys } = await kv.list();
	await Promise.all(keys.map((k) => kv.delete(k.name)));
}

beforeEach(async () => {
	await clearAllKeys();
});

describe('createSession / getSession', () => {
	it('stores a session record retrievable by its id', async () => {
		await createSession(kv, 'sess-1', makeRecord('u1'));

		const record = await getSession(kv, 'sess-1');
		expect(record?.userId).toBe('u1');
	});

	it('returns null for an id that was never created', async () => {
		expect(await getSession(kv, 'never-existed')).toBeNull();
	});
});

describe('deleteSession', () => {
	it('removes the session so it can no longer be read', async () => {
		await createSession(kv, 'sess-1', makeRecord('u1'));

		await deleteSession(kv, 'sess-1');

		expect(await getSession(kv, 'sess-1')).toBeNull();
	});

	it('is a no-op for a session that does not exist', async () => {
		await expect(deleteSession(kv, 'never-existed')).resolves.not.toThrow();
	});

	it("removes only the deleted session from the user's reverse index, leaving a sibling session resolvable", async () => {
		await createSession(kv, 'sess-1', makeRecord('u1'));
		await createSession(kv, 'sess-2', makeRecord('u1'));

		await deleteSession(kv, 'sess-1');

		// deleteAllSessionsForUser reads the same reverse index deleteSession
		// maintains — if deleting sess-1 had wiped the whole index instead of
		// just removing its own entry, this would fail to reach sess-2 too.
		await deleteAllSessionsForUser(kv, 'u1');
		expect(await getSession(kv, 'sess-2')).toBeNull();
	});
});

describe('deleteAllSessionsForUser', () => {
	it('deletes every session belonging to the user', async () => {
		await createSession(kv, 'sess-1', makeRecord('u1'));
		await createSession(kv, 'sess-2', makeRecord('u1'));

		await deleteAllSessionsForUser(kv, 'u1');

		expect(await getSession(kv, 'sess-1')).toBeNull();
		expect(await getSession(kv, 'sess-2')).toBeNull();
	});

	it("does not affect another user's sessions", async () => {
		await createSession(kv, 'sess-1', makeRecord('u1'));
		await createSession(kv, 'sess-2', makeRecord('u2'));

		await deleteAllSessionsForUser(kv, 'u1');

		expect(await getSession(kv, 'sess-2')).not.toBeNull();
	});

	it('is a no-op for a user with no sessions', async () => {
		await expect(deleteAllSessionsForUser(kv, 'never-logged-in')).resolves.not.toThrow();
	});
});
