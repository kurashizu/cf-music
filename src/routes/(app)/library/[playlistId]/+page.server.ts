import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	getPlaylistMeta,
	getPlaylistSongsInRange,
	listPlaylists,
	ensureDefaultPlaylist,
	LibraryError
} from '$lib/server/library/playlists';
import { getObjectStorage } from '$lib/server/storage/factory';
import type { PageServerLoad } from './$types';

// Matches the client's own PAGE_SIZE (windowedIndices) — only this many
// songs are fetched from D1 and have covers presigned here; everything
// past it is fetched (full row data, not just a cover) on demand as the
// user scrolls or searches, via GET /api/playlists/[playlistId]/songs —
// see this page's own fetchMissingSongs/loadMore. Reading every song in
// a large playlist unconditionally on every page load was a confirmed
// live cost driver (see this file's git history) well before it was ever
// the presign work itself; both the D1 read and the presign signing now
// scale with what's actually visible, not with playlist size.
const INITIAL_PAGE_SIZE = 20;

export const load: PageServerLoad = async ({ platform, locals, params }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const db = getDb(platform!.env.DB);

	try {
		const [playlistMeta, firstPage, allPlaylists, { id: defaultPlaylistId }] = await Promise.all([
			getPlaylistMeta(db, params.playlistId, locals.session.userId),
			getPlaylistSongsInRange(db, params.playlistId, locals.session.userId, 0, INITIAL_PAGE_SIZE),
			listPlaylists(db, locals.session.userId),
			ensureDefaultPlaylist(db, locals.session.userId)
		]);

		// Thumbnails are presigned server-side, same as stream-url's audioUrl/
		// coverUrl — coverKey is a bare S3 object key, not a URL the browser
		// can load directly, and signing needs the storage credentials that
		// only exist on the server.
		const storage = getObjectStorage(platform!.env);
		const songsWithCovers = await Promise.all(
			firstPage.map(async (song) => ({
				...song,
				coverUrl: song.coverKey ? await storage.presignGetUrl(song.coverKey) : null
			}))
		);

		return {
			playlist: { ...playlistMeta, songs: songsWithCovers },
			// The client renders this many placeholder slots beyond what's
			// actually loaded, so scrolling/searching has something to
			// resolve against before its own fetch for that range returns.
			totalSongCount: playlistMeta.songCount,
			isDefaultPlaylist: params.playlistId === defaultPlaylistId,
			// Other playlists a song from this page can be copied into — the
			// current one is excluded, copying a song into the playlist it's
			// already in is a no-op the UI shouldn't offer.
			otherPlaylists: allPlaylists
				.filter((p) => p.id !== params.playlistId)
				.map((p) => ({ id: p.id, name: p.name }))
		};
	} catch (err) {
		if (err instanceof LibraryError) error(404, err.message);
		throw err;
	}
};
