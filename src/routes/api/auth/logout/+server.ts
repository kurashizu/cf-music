import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { logout } from '$lib/server/auth/service';
import { SESSION_COOKIE_NAME, clearedSessionCookieOptions } from '$lib/server/auth/cookie';

export const POST: RequestHandler = async ({ platform, cookies }) => {
	const sessionId = cookies.get(SESSION_COOKIE_NAME);
	if (sessionId) {
		const db = getDb(platform!.env.DB);
		await logout(db, sessionId);
		cookies.delete(SESSION_COOKIE_NAME, clearedSessionCookieOptions());
	}

	return json({ ok: true });
};
