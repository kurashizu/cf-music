import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getPlaylistWithSongs, LibraryError } from '$lib/server/library/playlists';
import { getObjectStorage } from '$lib/server/storage/factory';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals, params }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const db = getDb(platform!.env.DB);

	try {
		const playlist = await getPlaylistWithSongs(db, params.playlistId, locals.session.userId);

		// Thumbnails are presigned server-side, same as stream-url's audioUrl/
		// coverUrl — coverKey is a bare S3 object key, not a URL the browser
		// can load directly, and signing needs the storage credentials that
		// only exist on the server.
		const storage = getObjectStorage(platform!.env);
		const songsWithCovers = await Promise.all(
			playlist.songs.map(async (song) => ({
				...song,
				coverUrl: song.coverKey ? await storage.presignGetUrl(song.coverKey) : null
			}))
		);

		return { playlist: { ...playlist, songs: songsWithCovers } };
	} catch (err) {
		if (err instanceof LibraryError) error(404, err.message);
		throw err;
	}
};
