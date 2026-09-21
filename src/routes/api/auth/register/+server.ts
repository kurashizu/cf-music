import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { register, login, AuthError } from '$lib/server/auth/service';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '$lib/server/auth/cookie';
import { pickStrings } from '$lib/server/http/validate';
import { usernameProblem, passwordProblem } from '$lib/shared/credential-rules';

export const POST: RequestHandler = async ({ request, platform, cookies, getClientAddress }) => {
	const body = await request.json().catch(() => null);
	const fields = pickStrings(body, ['username', 'password', 'inviteCode'] as const);
	if (!fields) {
		error(400, 'username, password, and inviteCode are required');
	}

	const { username, password, inviteCode } = fields;

	const usernameIssue = usernameProblem(username);
	if (usernameIssue) error(400, usernameIssue);
	const passwordIssue = passwordProblem(password);
	if (passwordIssue) error(400, passwordIssue);

	const db = getDb(platform!.env);

	try {
		await register(db, { username, password, inviteCode, ipAddress: getClientAddress() });
	} catch (err) {
		if (err instanceof AuthError) {
			error(err.code === 'invalid_invite_code' ? 403 : 409, err.message);
		}
		throw err;
	}

	// Register + immediately log in, so the client gets a session without a second round-trip.
	const { sessionId, userId, expiresAt } = await login(db, platform!.env.SESSION_KV, {
		username,
		password,
		userAgent: request.headers.get('user-agent') ?? undefined,
		ipAddress: getClientAddress()
	});

	cookies.set(SESSION_COOKIE_NAME, sessionId, sessionCookieOptions(expiresAt));

	return json({ userId, username }, { status: 201 });
};
