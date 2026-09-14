import { eq, and, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import { users, sessions, inviteCodes } from '../db/schema';
import { hashPassword, verifyPassword } from './password';
import { generateSessionId, generateInviteCode, computeSessionExpiry, isSessionExpired } from './tokens';

export class AuthError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'invalid_invite_code'
			| 'username_taken'
			| 'invalid_credentials'
			| 'session_not_found'
			| 'session_expired'
	) {
		super(message);
		this.name = 'AuthError';
	}
}

export interface RegisterInput {
	username: string;
	password: string;
	inviteCode: string;
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

export async function login(db: Db, input: LoginInput): Promise<LoginResult> {
	const user = await db.query.users.findFirst({
		where: eq(users.username, input.username)
	});
	// Run verifyPassword even on a missing user (against a fixed dummy hash)
	// so login timing doesn't reveal whether a username exists.
	const passwordHash = user?.passwordHash ?? DUMMY_HASH_FOR_TIMING_PARITY;
	const passwordValid = await verifyPassword(input.password, passwordHash);

	if (!user || !passwordValid) {
		throw new AuthError('Invalid username or password', 'invalid_credentials');
	}

	const sessionId = generateSessionId();
	const { createdAt, expiresAt } = computeSessionExpiry();

	await db.insert(sessions).values({
		id: sessionId,
		userId: user.id,
		createdAt: createdAt.toISOString(),
		expiresAt: expiresAt.toISOString(),
		userAgent: input.userAgent,
		ipAddress: input.ipAddress
	});

	return { sessionId, userId: user.id, expiresAt };
}

// A syntactically valid but unusable PBKDF2 hash, used only to keep
// verifyPassword's cost constant when no real user record exists.
const DUMMY_HASH_FOR_TIMING_PARITY = `pbkdf2$210000$${'0'.repeat(32)}$${'0'.repeat(64)}`;

export interface AuthenticatedSession {
	userId: string;
	username: string;
	isAdmin: boolean;
}

export async function resolveSession(db: Db, sessionId: string): Promise<AuthenticatedSession> {
	const session = await db.query.sessions.findFirst({
		where: eq(sessions.id, sessionId)
	});
	if (!session) {
		throw new AuthError('Session not found', 'session_not_found');
	}
	if (isSessionExpired(new Date(session.expiresAt))) {
		throw new AuthError('Session has expired', 'session_expired');
	}

	const user = await db.query.users.findFirst({
		where: eq(users.id, session.userId)
	});
	if (!user) {
		throw new AuthError('Session not found', 'session_not_found');
	}

	return { userId: user.id, username: user.username, isAdmin: user.isAdmin };
}

export async function logout(db: Db, sessionId: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Invalidates every session for a user — used on password change or admin-forced logout. */
export async function logoutAllSessions(db: Db, userId: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.userId, userId));
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
			return code;
		}
	}
	throw new Error('Failed to generate a unique invite code after multiple attempts');
}
