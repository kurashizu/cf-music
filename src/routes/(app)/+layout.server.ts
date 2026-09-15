import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listPlaylists } from '$lib/server/library/playlists';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ platform, locals }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	// Only id/name for the sidebar's playlist submenu — no cover
	// presigning here (unlike the library grid's own load), since this
	// runs on every (app) page and the sidebar list doesn't show art.
	const db = getDb(platform!.env.DB);
	const playlists = await listPlaylists(db, locals.session.userId);

	return {
		session: locals.session,
		sidebarPlaylists: playlists.map((p) => ({ id: p.id, name: p.name }))
	};
};
