import { eq, and, isNull, desc } from 'drizzle-orm';
import type { Db } from '../db';
import { users, inviteCodes } from '../db/schema';
import { hashPassword, verifyPassword, PBKDF2_ITERATIONS } from './password';
import {
	generateSessionId,
	generateInviteCode,
	computeSessionExpiry,
	isSessionExpired
} from './tokens';
import { createSession, getSession, deleteSession, deleteAllSessionsForUser } from './sessions';
import { recordAuditEvent } from '../audit/log';

export class AuthError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'invalid_invite_code'
			| 'username_taken'
			| 'invalid_credentials'
			| 'session_not_found'
			| 'session_expired'
			| 'account_disabled'
			| 'user_not_found'
			| 'last_admin'
			| 'cannot_target_self'
	) {
		super(message);
		this.name = 'AuthError';
	}
}

export interface RegisterInput {
	username: string;
	password: string;
	inviteCode: string;
	ipAddress?: string;
}

export interface RegisteredUser {
	id: string;
	username: string;
}

/**
 * Registers a new user against a one-time invite code. The invite code
 * must exist and be unused; it's marked consumed atomically with user
 * creation so a code can never be redeemed twice, even under concurrent
 * registration attempts using the same code.
 */
export async function register(db: Db, input: RegisterInput): Promise<RegisteredUser> {
	const invite = await db.query.inviteCodes.findFirst({
		where: and(eq(inviteCodes.code, input.inviteCode), isNull(inviteCodes.usedBy))
	});
	if (!invite) {
		throw new AuthError('Invite code is invalid or already used', 'invalid_invite_code');
	}

	const existing = await db.query.users.findFirst({
		where: eq(users.username, input.username)
	});
	if (existing) {
		throw new AuthError('Username is already taken', 'username_taken');
	}

	const passwordHash = await hashPassword(input.password);
	const userId = crypto.randomUUID();

	await db.insert(users).values({ id: userId, username: input.username, passwordHash });
	await db
		.update(inviteCodes)
		.set({ usedBy: userId, usedAt: new Date().toISOString() })
		.where(eq(inviteCodes.code, input.inviteCode));

	await recordAuditEvent(db, {
		userId,
		actorId: userId,
		eventType: 'invite_used',
		targetType: 'user',
		targetId: userId,
		detail: { inviteCode: input.inviteCode },
		ipAddress: input.ipAddress
	});

	return { id: userId, username: input.username };
}

export interface LoginInput {
	username: string;
	password: string;
	userAgent?: string;
	ipAddress?: string;
}

export interface LoginResult {
	sessionId: string;
	userId: string;
	expiresAt: Date;
}

export async function login(db: Db, kv: KVNamespace, input: LoginInput): Promise<LoginResult> {
	const user = await db.query.users.findFirst({
		where: eq(users.username, input.username)
	});
	// Run verifyPassword even on a missing user (against a fixed dummy hash)
	// so login timing doesn't reveal whether a username exists.
	const passwordHash = user?.passwordHash ?? DUMMY_HASH_FOR_TIMING_PARITY;
	const passwordValid = await verifyPassword(input.password, passwordHash);

	if (!user || !passwordValid) {
		// Only log against a real user id (userId left null for an unknown
		// username) — logging a failed attempt against a username that
		// doesn't exist would let the audit log itself leak which usernames
		// are registered, the same enumeration risk verifyPassword's timing
		// parity above is already defending against.
		await recordAuditEvent(db, {
			userId: user?.id ?? null,
			eventType: 'login_failed',
			targetType: 'user',
			targetId: user?.id ?? null,
			ipAddress: input.ipAddress
		});
		throw new AuthError('Invalid username or password', 'invalid_credentials');
	}

	// Checked only after the password verified: reporting "disabled" to
	// someone who didn't prove they own the account would turn login into
	// a way to enumerate which usernames exist and which are suspended.
	if (user.disabled) {
		await recordAuditEvent(db, {
			userId: user.id,
			eventType: 'login_failed',
			targetType: 'user',
			targetId: user.id,
			detail: { reason: 'account_disabled' },
			ipAddress: input.ipAddress
		});
		throw new AuthError('This account has been disabled', 'account_disabled');
	}

	const sessionId = generateSessionId();
	const { createdAt, expiresAt } = computeSessionExpiry();

	await createSession(kv, sessionId, {
		userId: user.id,
		createdAt: createdAt.toISOString(),
		expiresAt: expiresAt.toISOString(),
		userAgent: input.userAgent,
		ipAddress: input.ipAddress
	});

	await recordAuditEvent(db, {
		userId: user.id,
		actorId: user.id,
		eventType: 'login',
		targetType: 'user',
		targetId: user.id,
		ipAddress: input.ipAddress
	});

	return { sessionId, userId: user.id, expiresAt };
}

// A syntactically valid but unusable PBKDF2 hash, used only to keep
// verifyPassword's cost constant when no real user record exists. The
// iteration count has to be the real one: hardcoding a different value
// made verifyPassword throw instead of returning false, so logging in
// with an unknown username 500'd rather than being rejected -- and cost
// nothing to compute, which is the opposite of timing parity.
export const DUMMY_HASH_FOR_TIMING_PARITY = `pbkdf2$${PBKDF2_ITERATIONS}$${'0'.repeat(32)}$${'0'.repeat(64)}`;

export interface AuthenticatedSession {
	userId: string;
	username: string;
	isAdmin: boolean;
}

export async function resolveSession(
	db: Db,
	kv: KVNamespace,
	sessionId: string
): Promise<AuthenticatedSession> {
	const session = await getSession(kv, sessionId);
	if (!session) {
		throw new AuthError('Session not found', 'session_not_found');
	}
	// Belt-and-suspenders alongside KV's own expirationTtl (set at write
	// time in createSession) rather than the only expiry check: TTL
	// expiry is on a best-effort background sweep in KV, not guaranteed to
	// have already happened the instant the clock ticks past expiresAt.
	if (isSessionExpired(new Date(session.expiresAt))) {
		throw new AuthError('Session has expired', 'session_expired');
	}

	const user = await db.query.users.findFirst({
		where: eq(users.id, session.userId)
	});
	if (!user) {
		throw new AuthError('Session not found', 'session_not_found');
	}
	// Disabling has to end the sessions a user already holds, not merely
	// stop them getting a new one — otherwise a suspended account keeps
	// working until its session happens to expire, which can be days.
	// Reported as a missing session so the app treats it as logged out.
	if (user.disabled) {
		throw new AuthError('Session not found', 'session_not_found');
	}

	return { userId: user.id, username: user.username, isAdmin: user.isAdmin };
}

export async function logout(kv: KVNamespace, sessionId: string): Promise<void> {
	await deleteSession(kv, sessionId);
}

/** Invalidates every session for a user — used on password change or admin-forced logout. */
export async function logoutAllSessions(kv: KVNamespace, userId: string): Promise<void> {
	await deleteAllSessionsForUser(kv, userId);
}

const MAX_INVITE_CODE_GENERATION_ATTEMPTS = 5;

/**
 * Creates a fresh one-time invite code, retrying on the astronomically
 * unlikely event of a collision with an existing code (the code space is
 * ~33^20, so this loop is defensive, not load-bearing).
 */
export async function createInviteCode(db: Db, createdBy: string): Promise<string> {
	for (let attempt = 0; attempt < MAX_INVITE_CODE_GENERATION_ATTEMPTS; attempt++) {
		const code = generateInviteCode();
		const existing = await db.query.inviteCodes.findFirst({ where: eq(inviteCodes.code, code) });
		if (!existing) {
			await db.insert(inviteCodes).values({ code, createdBy });
			await recordAuditEvent(db, {
				actorId: createdBy,
				eventType: 'invite_created',
				detail: { code }
			});
			return code;
		}
	}
	throw new Error('Failed to generate a unique invite code after multiple attempts');
}

export interface AdminUserSummary {
	id: string;
	username: string;
	isAdmin: boolean;
	storageQuotaBytes: number;
	autoEvictEnabled: boolean;
	disabled: boolean;
	createdAt: string;
}

/** Admin-only: every registered user, most recently created first. */
export async function listUsers(db: Db): Promise<AdminUserSummary[]> {
	return db.query.users.findMany({
		columns: {
			id: true,
			username: true,
			isAdmin: true,
			storageQuotaBytes: true,
			autoEvictEnabled: true,
			disabled: true,
			createdAt: true
		},
		orderBy: desc(users.createdAt)
	});
}
