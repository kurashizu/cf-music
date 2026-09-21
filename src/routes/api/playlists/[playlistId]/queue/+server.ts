import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { getPlaylistQueue, LibraryError } from '$lib/server/library/playlists';

/**
 * A playlist's running order for the player queue: videoId, title and
 * duration only.
 *
 * Separate from the paged ../songs endpoint because the two want opposite
 * things. That one renders rows, so it presigns a cover URL per song and
 * is paged to keep each response cheap. A queue reads none of that, and
 * needs the whole list at once to know where a song sits — asking ../songs
 * for it meant ten requests and a presign per song to build something that
 * discards every cover.
 */
export const GET: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env);

	try {
		return json(await getPlaylistQueue(db, event.params.playlistId, session.userId));
	} catch (err) {
		if (err instanceof LibraryError) error(404, err.message);
		throw err;
	}
};
