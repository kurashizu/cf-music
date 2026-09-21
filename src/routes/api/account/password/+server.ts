import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { changeOwnPassword } from '$lib/server/auth/account';
import { AuthError } from '$lib/server/auth/service';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '$lib/server/auth/cookie';
import { login } from '$lib/server/auth/service';
import { pickStrings } from '$lib/server/http/validate';
import { passwordProblem } from '$lib/shared/credential-rules';

/**
 * Changes the caller's own password, which ends every session including
 * this one (see setPassword). A fresh session is issued for the caller so
 * that changing your password doesn't log you out of the tab you did it
 * in — everywhere else still gets signed out, which is the point.
 */
export const PUT: RequestHandler = async (event) => {
	const session = requireSession(event);
	const body = await event.request.json().catch(() => null);

	const fields = pickStrings(body, ['currentPassword', 'newPassword'] as const);
	if (!fields) error(400, 'currentPassword and newPassword are required');

	const problem = passwordProblem(fields.newPassword);
	if (problem) error(400, problem);

	const db = getDb(event.platform!.env);
	const kv = event.platform!.env.SESSION_KV;

	try {
		await changeOwnPassword(db, kv, {
			userId: session.userId,
			currentPassword: fields.currentPassword,
			newPassword: fields.newPassword,
			ipAddress: event.getClientAddress()
		});
	} catch (err) {
		if (err instanceof AuthError) {
			error(err.code === 'invalid_credentials' ? 403 : 404, err.message);
		}
		throw err;
	}

	const { sessionId, expiresAt } = await login(db, kv, {
		username: session.username,
		password: fields.newPassword,
		userAgent: event.request.headers.get('user-agent') ?? undefined,
		ipAddress: event.getClientAddress()
	});
	event.cookies.set(SESSION_COOKIE_NAME, sessionId, sessionCookieOptions(expiresAt));

	return json({ ok: true });
};
