import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { getPlaylistWithSongs, renamePlaylist, deletePlaylist, LibraryError } from '$lib/server/library/playlists';
import { pickStrings } from '$lib/server/http/validate';

export const GET: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env.DB);

	try {
		return json(await getPlaylistWithSongs(db, event.params.playlistId, session.userId));
	} catch (err) {
		if (err instanceof LibraryError) error(404, err.message);
		throw err;
	}
};

export const PATCH: RequestHandler = async (event) => {
	const session = requireSession(event);
	const body = await event.request.json().catch(() => null);
	const fields = pickStrings(body, ['name'] as const);
	if (!fields || fields.name.trim().length === 0) {
		error(400, 'name is required');
	}

	const db = getDb(event.platform!.env.DB);
	try {
		await renamePlaylist(db, event.params.playlistId, session.userId, fields.name);
	} catch (err) {
		if (err instanceof LibraryError) error(404, err.message);
		throw err;
	}

	return json({ ok: true });
};

export const DELETE: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env.DB);

	try {
		await deletePlaylist(db, event.params.playlistId, session.userId);
	} catch (err) {
		if (err instanceof LibraryError) {
			if (err.code === 'default_playlist_protected') error(400, err.message);
			error(404, err.message);
		}
		throw err;
	}

	return json({ ok: true });
};
