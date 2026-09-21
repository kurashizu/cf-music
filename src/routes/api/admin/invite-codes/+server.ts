import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { createInviteCode } from '$lib/server/auth/service';
import { inviteCodes } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const db = getDb(event.platform!.env);

	const codes = await db.query.inviteCodes.findMany({
		orderBy: desc(inviteCodes.createdAt)
	});

	return json(codes);
};

export const POST: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const db = getDb(event.platform!.env);

	const code = await createInviteCode(db, admin.userId);

	return json({ code }, { status: 201 });
};
