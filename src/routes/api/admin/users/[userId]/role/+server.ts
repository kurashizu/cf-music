import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { setUserAdmin } from '$lib/server/auth/account';
import { AuthError } from '$lib/server/auth/service';

/** Grants or revokes admin. Refuses to remove the last one — see setUserAdmin. */
export const PUT: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const body = await event.request.json().catch(() => null);

	const isAdmin = (body as { isAdmin?: unknown } | null)?.isAdmin;
	if (typeof isAdmin !== 'boolean') error(400, 'isAdmin must be a boolean');

	const db = getDb(event.platform!.env);
	try {
		await setUserAdmin(db, {
			actorId: admin.userId,
			targetUserId: event.params.userId,
			isAdmin,
			ipAddress: event.getClientAddress()
		});
	} catch (err) {
		if (err instanceof AuthError) {
			error(err.code === 'user_not_found' ? 404 : 409, err.message);
		}
		throw err;
	}

	return json({ ok: true });
};
