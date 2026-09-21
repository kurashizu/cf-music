import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { revokeInviteCode, AuthError } from '$lib/server/auth/service';

/** Withdraws an invite code, used or not — see revokeInviteCode. */
export const DELETE: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const db = getDb(event.platform!.env);

	try {
		await revokeInviteCode(db, event.params.code, admin.userId);
	} catch (err) {
		if (err instanceof AuthError) error(404, err.message);
		throw err;
	}

	return json({ ok: true });
};
