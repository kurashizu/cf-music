import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listPlaylists, ensureDefaultPlaylist } from '$lib/server/library/playlists';
import { listSmartPlaylists } from '$lib/server/library/smart-playlists';
import { getObjectStorage } from '$lib/server/storage/factory';
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
	const [playlists, smartPlaylists, { id: defaultPlaylistId }] = await Promise.all([
		listPlaylists(db, locals.session.userId),
		listSmartPlaylists(db, locals.session.userId),
		ensureDefaultPlaylist(db, locals.session.userId)
	]);

	// Playlists/smart playlists carry a member song's raw coverKey (see
	// listPlaylists/listSmartPlaylists) as their auto-generated thumbnail —
	// same presign-on-the-server pattern as the playlist detail page, since
	// only the server has the storage credentials to sign it.
	const storage = getObjectStorage(platform!.env);
	const [playlistsWithCovers, smartPlaylistsWithCovers] = await Promise.all([
		Promise.all(
			playlists.map(async (playlist) => ({
				...playlist,
				coverUrl: playlist.coverKey ? await storage.presignGetUrl(playlist.coverKey) : null
			}))
		),
		Promise.all(
			smartPlaylists.map(async (group) => ({
				...group,
				coverUrl: group.coverKey ? await storage.presignGetUrl(group.coverKey) : null
			}))
		)
	]);

	return { playlists: playlistsWithCovers, smartPlaylists: smartPlaylistsWithCovers, defaultPlaylistId };
};
