import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { removeSongFromPlaylist, addSongToPlaylist, LibraryError } from '$lib/server/library/playlists';
import { pickStrings } from '$lib/server/http/validate';

function handleLibraryError(err: unknown): never {
	if (err instanceof LibraryError) {
		if (err.code === 'default_playlist_protected') error(400, err.message);
		error(404, err.message);
	}
	throw err;
}

export const DELETE: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env.DB);

	try {
		await removeSongFromPlaylist(db, event.params.playlistId, session.userId, event.params.videoId);
	} catch (err) {
		handleLibraryError(err);
	}

	return json({ ok: true });
};

/** Copies this song into { toPlaylistId } — the URL's playlist keeps it too, this only ever adds. */
export const PUT: RequestHandler = async (event) => {
	const session = requireSession(event);

	const body = await event.request.json().catch(() => null);
	const fields = pickStrings(body, ['toPlaylistId'] as const);
	if (!fields) {
		error(400, 'toPlaylistId is required');
	}

	const db = getDb(event.platform!.env.DB);
	try {
		await addSongToPlaylist(db, fields.toPlaylistId, session.userId, event.params.videoId);
	} catch (err) {
		handleLibraryError(err);
	}

	return json({ ok: true });
};
