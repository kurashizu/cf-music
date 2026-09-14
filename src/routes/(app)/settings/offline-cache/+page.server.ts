import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listCachePreferences } from '$lib/server/cache/preferences';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const db = getDb(platform!.env.DB);
	const entries = await listCachePreferences(db, locals.session.userId);

	return { entries };
};
