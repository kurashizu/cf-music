import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { listAuditLog } from '$lib/server/audit/log';

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const db = getDb(event.platform!.env.DB);

	const limitParam = event.url.searchParams.get('limit');
	const limit = limitParam ? Number(limitParam) : undefined;

	return json(await listAuditLog(db, { limit: Number.isFinite(limit) ? limit : undefined }));
};
