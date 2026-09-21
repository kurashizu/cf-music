import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { adminResetPassword } from '$lib/server/auth/account';
import { AuthError } from '$lib/server/auth/service';
import { pickStrings } from '$lib/server/http/validate';
import { passwordProblem } from '$lib/shared/credential-rules';

/** Sets a user's password without knowing their old one — see adminResetPassword. */
export const PUT: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const body = await event.request.json().catch(() => null);

	const fields = pickStrings(body, ['newPassword'] as const);
	if (!fields) error(400, 'newPassword is required');

	const problem = passwordProblem(fields.newPassword);
	if (problem) error(400, problem);

	const db = getDb(event.platform!.env);
	try {
		await adminResetPassword(db, event.platform!.env.SESSION_KV, {
			actorId: admin.userId,
			targetUserId: event.params.userId,
			newPassword: fields.newPassword,
			ipAddress: event.getClientAddress()
		});
	} catch (err) {
		if (err instanceof AuthError) error(404, err.message);
		throw err;
	}

	return json({ ok: true });
};
