import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { setUserDisabled } from '$lib/server/auth/account';
import { AuthError } from '$lib/server/auth/service';

/** Suspends or restores an account without touching its data. */
export const PUT: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const body = await event.request.json().catch(() => null);

	const disabled = (body as { disabled?: unknown } | null)?.disabled;
	if (typeof disabled !== 'boolean') error(400, 'disabled must be a boolean');

	const db = getDb(event.platform!.env);
	try {
		await setUserDisabled(db, event.platform!.env.SESSION_KV, {
			actorId: admin.userId,
			targetUserId: event.params.userId,
			disabled,
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
