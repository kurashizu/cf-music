import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { setUserQuotaBytes } from '$lib/server/eviction/usage';
import { pickPositiveNumber } from '$lib/server/http/validate';

export const PUT: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const body = await event.request.json().catch(() => null);

	const quotaBytes = pickPositiveNumber(body, 'quotaBytes');
	if (quotaBytes === null) {
		error(400, 'quotaBytes must be a positive number');
	}

	const db = getDb(event.platform!.env);
	try {
		await setUserQuotaBytes(db, event.params.userId, quotaBytes, admin.userId);
	} catch {
		error(404, 'User not found');
	}

	return json({ ok: true });
};
