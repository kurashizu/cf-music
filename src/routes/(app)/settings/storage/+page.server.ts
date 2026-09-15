import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listCachePreferences } from '$lib/server/cache/preferences';
import { getUserQuotaBytes, getUserStorageUsageBytes } from '$lib/server/eviction/usage';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const db = getDb(platform!.env.DB);
	const [entries, quotaBytes, usageBytes] = await Promise.all([
		listCachePreferences(db, locals.session.userId),
		getUserQuotaBytes(db, locals.session.userId),
		getUserStorageUsageBytes(db, locals.session.userId)
	]);

	return { entries, quotaBytes, usageBytes };
};
