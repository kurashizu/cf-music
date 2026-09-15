import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { login, AuthError } from '$lib/server/auth/service';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '$lib/server/auth/cookie';
import { pickStrings } from '$lib/server/http/validate';

export const POST: RequestHandler = async ({ request, platform, cookies, getClientAddress }) => {
	const body = await request.json().catch(() => null);
	const fields = pickStrings(body, ['username', 'password'] as const);
	if (!fields) {
		error(400, 'username and password are required');
	}

	const { username, password } = fields;
	const db = getDb(platform!.env.DB);

	try {
		const { sessionId, userId, expiresAt } = await login(db, platform!.env.SESSION_KV, {
			username,
			password,
			userAgent: request.headers.get('user-agent') ?? undefined,
			ipAddress: getClientAddress()
		});

		cookies.set(SESSION_COOKIE_NAME, sessionId, sessionCookieOptions(expiresAt));

		return json({ userId, username });
	} catch (err) {
		if (err instanceof AuthError) {
			error(401, 'Invalid username or password');
		}
		throw err;
	}
};
