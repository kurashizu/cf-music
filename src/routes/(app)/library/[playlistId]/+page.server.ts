import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getPlaylistWithSongs, listPlaylists, ensureDefaultPlaylist, LibraryError } from '$lib/server/library/playlists';
import { getObjectStorage } from '$lib/server/storage/factory';
import type { PageServerLoad } from './$types';

// Matches the client's own PAGE_SIZE (windowedIndices) — only the songs
// that actually render on first paint get a presigned coverUrl here.
// Presigning is real per-call AWS SigV4 work (aws4fetch's hmac() does 4
// chained crypto.subtle.importKey calls per sign — the key derivation
// ladder, not the final signature alone), so presigning the whole
// playlist unconditionally made this load scale with library size: a
// confirmed live regression where a 365-song "All Imported" playlist
// took ~200ms of pure signing work before the page could render at all.
// Everything past this window gets coverUrl: null here and is presigned
// on demand instead, see /api/playlists/[playlistId]/songs and this
// page's own loadMore().
const INITIAL_PRESIGN_COUNT = 20;

export const load: PageServerLoad = async ({ platform, locals, params }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const db = getDb(platform!.env.DB);

	try {
		const [playlist, allPlaylists, { id: defaultPlaylistId }] = await Promise.all([
			getPlaylistWithSongs(db, params.playlistId, locals.session.userId),
			listPlaylists(db, locals.session.userId),
			ensureDefaultPlaylist(db, locals.session.userId)
		]);

		// Thumbnails are presigned server-side, same as stream-url's audioUrl/
		// coverUrl — coverKey is a bare S3 object key, not a URL the browser
		// can load directly, and signing needs the storage credentials that
		// only exist on the server.
		const storage = getObjectStorage(platform!.env);
		const songsWithCovers = await Promise.all(
			playlist.songs.map(async (song, index) => ({
				...song,
				coverUrl:
					song.coverKey && index < INITIAL_PRESIGN_COUNT ? await storage.presignGetUrl(song.coverKey) : null
			}))
		);

		return {
			playlist: { ...playlist, songs: songsWithCovers },
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
