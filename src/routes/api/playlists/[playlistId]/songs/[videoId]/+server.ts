import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { removeSongFromPlaylist, LibraryError } from '$lib/server/library/playlists';

export const DELETE: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env.DB);

	try {
		await removeSongFromPlaylist(db, event.params.playlistId, session.userId, event.params.videoId);
	} catch (err) {
		if (err instanceof LibraryError) error(404, err.message);
		throw err;
	}

	return json({ ok: true });
};
