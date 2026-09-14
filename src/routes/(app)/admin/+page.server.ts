import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listUsers } from '$lib/server/auth/service';
import { listAuditLog } from '$lib/server/audit/log';
import { inviteCodes } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.session) {
		redirect(303, '/');
	}
	if (!locals.session.isAdmin) {
		redirect(303, '/library');
	}

	const db = getDb(platform!.env.DB);
	const [users, auditEntries, codes] = await Promise.all([
		listUsers(db),
		listAuditLog(db, { limit: 50 }),
		db.query.inviteCodes.findMany({ orderBy: desc(inviteCodes.createdAt), limit: 50 })
	]);

	return { users, auditEntries, inviteCodes: codes };
};
