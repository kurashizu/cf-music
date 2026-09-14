import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { reorderPlaylist, LibraryError } from '$lib/server/library/playlists';
import { pickStringArray } from '$lib/server/http/validate';

export const PUT: RequestHandler = async (event) => {
	const session = requireSession(event);
	const body = await event.request.json().catch(() => null);

	const orderedVideoIds = pickStringArray(body, 'orderedVideoIds');
	if (!orderedVideoIds) {
		error(400, 'orderedVideoIds must be an array of strings');
	}

	const db = getDb(event.platform!.env.DB);
	try {
		await reorderPlaylist(db, event.params.playlistId, session.userId, orderedVideoIds);
	} catch (err) {
		if (err instanceof LibraryError) {
			error(err.code === 'not_found' ? 404 : 400, err.message);
		}
		throw err;
	}

	return json({ ok: true });
};
