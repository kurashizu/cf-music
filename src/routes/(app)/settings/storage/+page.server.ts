import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listUserLibrarySongs, listPlaylists } from '$lib/server/library/playlists';
import { getUserQuotaBytes, getUserStorageUsageBytes } from '$lib/server/eviction/usage';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const db = getDb(platform!.env.DB);
	const [entries, quotaBytes, usageBytes, playlists] = await Promise.all([
		listUserLibrarySongs(db, locals.session.userId),
		getUserQuotaBytes(db, locals.session.userId),
		getUserStorageUsageBytes(db, locals.session.userId),
		listPlaylists(db, locals.session.userId)
	]);

	return {
		entries,
		quotaBytes,
		usageBytes,
		// This page spans the whole library (every playlist a song might be
		// in), not one specific playlist — "copy to" needs a full list to
		// pick from, unlike the playlist detail page which excludes just
		// the one it's already showing.
		playlists: playlists.map((p) => ({ id: p.id, name: p.name }))
	};
};
