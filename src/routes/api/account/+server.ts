import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { deleteUser } from '$lib/server/auth/account';
import { AuthError } from '$lib/server/auth/service';
import { verifyPassword } from '$lib/server/auth/password';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getObjectStorage } from '$lib/server/storage/factory';
import { SESSION_COOKIE_NAME } from '$lib/server/auth/cookie';
import { pickStrings } from '$lib/server/http/validate';

/**
 * Deletes the caller's own account.
 *
 * Requires the password even though the caller is already authenticated:
 * this is the one irreversible action in the app, and a session left open
 * on a shared machine shouldn't be enough to destroy someone's library.
 */
export const DELETE: RequestHandler = async (event) => {
	const session = requireSession(event);
	const body = await event.request.json().catch(() => null);

	const fields = pickStrings(body, ['password'] as const);
	if (!fields) error(400, 'password is required');

	const db = getDb(event.platform!.env);
	const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) });
	if (!user) error(404, 'User not found');

	if (!(await verifyPassword(fields.password, user.passwordHash))) {
		error(403, 'Password is incorrect');
	}

	try {
		const result = await deleteUser(
			db,
			event.platform!.env.SESSION_KV,
			getObjectStorage(event.platform!.env),
			{
				actorId: session.userId,
				targetUserId: session.userId,
				ipAddress: event.getClientAddress()
			}
		);
		event.cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
		return json(result);
	} catch (err) {
		if (err instanceof AuthError) {
			error(err.code === 'user_not_found' ? 404 : 409, err.message);
		}
		throw err;
	}
};
