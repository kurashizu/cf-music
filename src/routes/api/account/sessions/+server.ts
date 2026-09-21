import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { forceLogout } from '$lib/server/auth/account';
import { SESSION_COOKIE_NAME } from '$lib/server/auth/cookie';

/**
 * Signs the caller out everywhere, this tab included — unlike the password
 * change, which keeps the current session alive. Someone reaching for this
 * is usually worried a session is loose somewhere, and quietly exempting
 * the one they happen to be holding would leave them unsure which of the
 * two it was.
 */
export const DELETE: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env);

	await forceLogout(db, event.platform!.env.SESSION_KV, {
		actorId: session.userId,
		targetUserId: session.userId,
		ipAddress: event.getClientAddress()
	});
	event.cookies.delete(SESSION_COOKIE_NAME, { path: '/' });

	return json({ ok: true });
};
