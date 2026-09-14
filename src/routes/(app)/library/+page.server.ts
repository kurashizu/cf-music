import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listPlaylists } from '$lib/server/library/playlists';
import { listSmartPlaylists } from '$lib/server/library/smart-playlists';
import type { PageServerLoad } from './$types';

// Sibling `load` functions in a route's layout chain run in parallel, not
// sequentially — the (app)/+layout.server.ts session redirect is not
// guaranteed to happen before this one runs, so this can't just trust
// locals.session was already validated. Re-checking (and redirecting the
// same way the layout does, rather than a raw 401) is what actually
// enforces it for this specific load.
export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const db = getDb(platform!.env.DB);
	const [playlists, smartPlaylists] = await Promise.all([
		listPlaylists(db, locals.session.userId),
		listSmartPlaylists(db, locals.session.userId)
	]);

	return { playlists, smartPlaylists };
};
