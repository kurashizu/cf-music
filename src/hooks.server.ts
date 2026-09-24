import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { getDb } from '$lib/server/db';
import { resolveSession, AuthError } from '$lib/server/auth/service';
import { SESSION_COOKIE_NAME, clearedSessionCookieOptions } from '$lib/server/auth/cookie';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.session = null;

	// No route matched. Only /api/* and __data.json requests reach the Worker
	// at all (see wrangler.jsonc), so this is a misspelt endpoint rather than
	// a page anyone reads, and rendering +error.svelte for it on a fresh
	// isolate costs well past the free plan's 10ms CPU budget. Not while
	// building: the adapter renders the app shell through an unmatched URL.
	if (event.route.id === null && !building) {
		return new Response('Not Found', { status: 404 });
	}

	const sessionId = event.cookies.get(SESSION_COOKIE_NAME);
	if (sessionId) {
		const db = getDb(event.platform!.env);
		try {
			event.locals.session = await resolveSession(db, event.platform!.env.SESSION_KV, sessionId);
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
