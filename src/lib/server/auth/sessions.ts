const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — matches tokens.ts's computeSessionExpiry

export interface SessionRecord {
	userId: string;
	createdAt: string;
	expiresAt: string;
	userAgent?: string;
	ipAddress?: string;
}

function sessionKey(sessionId: string): string {
	return `session:${sessionId}`;
}

function userSessionsKey(userId: string): string {
	return `user-sessions:${userId}`;
}

/**
 * KV has no way to query "every session belonging to this user" directly
 * (no secondary indexes, and listing all session: keys account-wide to
 * filter client-side doesn't scale) — this per-user array is a hand-rolled
 * reverse index that logoutAllSessions depends on. It isn't kept in a
 * transaction with the session write (KV has none): the write order below
 * always does the thing that would leave a stale reference (adding to the
 * index) *before* the thing that could fail after (writing the session),
 * and readSessionIds are treated as best-effort at read time (see
 * logoutAllSessions) — an index entry pointing at an already-expired or
 * already-deleted session is a harmless no-op to clean up, not a
 * correctness problem the way a *missing* entry for a live session would
 * be.
 */
async function readSessionIds(kv: KVNamespace, userId: string): Promise<string[]> {
	const raw = await kv.get(userSessionsKey(userId));
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

async function writeSessionIds(
	kv: KVNamespace,
	userId: string,
	sessionIds: string[]
): Promise<void> {
	if (sessionIds.length === 0) {
		await kv.delete(userSessionsKey(userId));
		return;
	}
	await kv.put(userSessionsKey(userId), JSON.stringify(sessionIds), {
		expirationTtl: SESSION_TTL_SECONDS
	});
}

export async function createSession(
	kv: KVNamespace,
	sessionId: string,
	record: SessionRecord
): Promise<void> {
	// Index first: if this step succeeds but the actual session write below
	// fails, logoutAllSessions later finds a dangling id pointing at a
	// session that was never created — a no-op when it tries to delete it.
	// The opposite order risks the real failure mode: a session that exists
	// and works for login/resolveSession, but that logoutAllSessions can
	// never find because the index write never happened.
	const existing = await readSessionIds(kv, record.userId);
	await writeSessionIds(kv, record.userId, [...existing, sessionId]);
	await kv.put(sessionKey(sessionId), JSON.stringify(record), {
		expirationTtl: SESSION_TTL_SECONDS
	});
}

export async function getSession(
	kv: KVNamespace,
	sessionId: string
): Promise<SessionRecord | null> {
	return kv.get<SessionRecord>(sessionKey(sessionId), 'json');
}

export async function deleteSession(kv: KVNamespace, sessionId: string): Promise<void> {
	const record = await getSession(kv, sessionId);
	await kv.delete(sessionKey(sessionId));
	if (!record) return;

	const remaining = (await readSessionIds(kv, record.userId)).filter((id) => id !== sessionId);
	await writeSessionIds(kv, record.userId, remaining);
}

/** Deletes every session belonging to a user — see readSessionIds for why stale entries in the index are tolerated rather than treated as errors. */
export async function deleteAllSessionsForUser(kv: KVNamespace, userId: string): Promise<void> {
	const sessionIds = await readSessionIds(kv, userId);
	await Promise.all(sessionIds.map((id) => kv.delete(sessionKey(id))));
	await kv.delete(userSessionsKey(userId));
}
