import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listPlaylistsWithCovers, ensureDefaultPlaylist, listUserLibrarySongs } from '$lib/server/library/playlists';
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
	const [playlists, smartPlaylists, { id: defaultPlaylistId }, librarySongs] = await Promise.all([
		listPlaylistsWithCovers(db, locals.session.userId),
		listSmartPlaylists(db, locals.session.userId),
		ensureDefaultPlaylist(db, locals.session.userId),
		listUserLibrarySongs(db, locals.session.userId)
	]);

	// Playlists/smart playlists carry up to 4 member songs' raw coverKeys
	// (see listPlaylists/listSmartPlaylists) for a 2x2 mosaic thumbnail —
	// same presign-on-the-server pattern as the playlist detail page, since
	// only the server has the storage credentials to sign them.
	const storage = getObjectStorage(platform!.env);
	const [playlistsWithCovers, smartPlaylistsWithCovers] = await Promise.all([
		Promise.all(
			playlists.map(async (playlist) => ({
				...playlist,
				coverUrls: await Promise.all(playlist.coverKeys.map((key) => storage.presignGetUrl(key)))
			}))
		),
		Promise.all(
			smartPlaylists.map(async (group) => ({
				...group,
				coverUrls: await Promise.all(group.coverKeys.map((key) => storage.presignGetUrl(key)))
			}))
		)
	]);

	return {
		playlists: playlistsWithCovers,
		smartPlaylists: smartPlaylistsWithCovers,
		defaultPlaylistId,
		// videoId/title/artist/durationSeconds is all the global search
		// needs to both match and immediately start playback — it doesn't
		// need cover art, unlike the mosaic covers above, since a click
		// hands off straight to the player, which fetches its own cover URL.
		librarySongs: librarySongs.map((song) => ({
			videoId: song.videoId,
			title: song.title,
			artist: song.artist,
			durationSeconds: song.durationSeconds
		}))
	};
};
