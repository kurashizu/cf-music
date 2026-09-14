import type { Handle } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { resolveSession, AuthError } from '$lib/server/auth/service';
import { SESSION_COOKIE_NAME, clearedSessionCookieOptions } from '$lib/server/auth/cookie';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.session = null;

	const sessionId = event.cookies.get(SESSION_COOKIE_NAME);
	if (sessionId) {
		const db = getDb(event.platform!.env.DB);
		try {
			event.locals.session = await resolveSession(db, sessionId);
		} catch (err) {
			if (err instanceof AuthError) {
				// Stale/invalid cookie — clear it so the browser stops sending it.
				event.cookies.delete(SESSION_COOKIE_NAME, clearedSessionCookieOptions());
			} else {
				throw err;
			}
		}
	}

	return resolve(event);
};
