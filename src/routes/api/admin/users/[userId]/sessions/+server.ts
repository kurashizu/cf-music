import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { forceLogout } from '$lib/server/auth/account';
import { AuthError } from '$lib/server/auth/service';

/** Ends every session a user holds, leaving their password alone. */
export const DELETE: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const db = getDb(event.platform!.env);

	try {
		await forceLogout(db, event.platform!.env.SESSION_KV, {
			actorId: admin.userId,
			targetUserId: event.params.userId,
			ipAddress: event.getClientAddress()
		});
	} catch (err) {
		if (err instanceof AuthError) error(404, err.message);
		throw err;
	}

	return json({ ok: true });
};
