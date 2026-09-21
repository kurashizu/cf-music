import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { deleteUser } from '$lib/server/auth/account';
import { AuthError } from '$lib/server/auth/service';
import { getObjectStorage } from '$lib/server/storage/factory';

/**
 * Deletes an account and everything belonging to it. Songs go only if no
 * other user's playlist still references them — see deleteUser.
 */
export const DELETE: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const db = getDb(event.platform!.env);

	try {
		const result = await deleteUser(
			db,
			event.platform!.env.SESSION_KV,
			getObjectStorage(event.platform!.env),
			{
				actorId: admin.userId,
				targetUserId: event.params.userId,
				ipAddress: event.getClientAddress()
			}
		);
		return json(result);
	} catch (err) {
		if (err instanceof AuthError) {
			error(err.code === 'user_not_found' ? 404 : 409, err.message);
		}
		throw err;
	}
};
