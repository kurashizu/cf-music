import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listPlaylists } from '$lib/server/library/playlists';
import { SMART_PLAYLIST_NAMES } from '$lib/server/library/smart-playlists';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ platform, locals }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	// Only id/name for the sidebar's playlist submenu — no cover
	// presigning here (unlike the library grid's own load), since this
	// runs on every (app) page and the sidebar list doesn't show art.
	const db = getDb(platform!.env.DB);
	const allPlaylists = await listPlaylists(db, locals.session.userId, 'all');
	const smartPlaylistNames = new Set<string>(SMART_PLAYLIST_NAMES);

	return {
		session: locals.session,
		sidebarPlaylists: allPlaylists.filter((p) => p.kind === 'user').map((p) => ({ id: p.id, name: p.name })),
		// Only the 6 fixed smart playlists, not Artists groupings — the
		// sidebar has no room for a whole second category the way the
		// library page's grid does.
		sidebarSmartPlaylists: allPlaylists
			.filter((p) => p.kind === 'auto_generated' && smartPlaylistNames.has(p.name))
			.map((p) => ({ id: p.id, name: p.name }))
	};
};
