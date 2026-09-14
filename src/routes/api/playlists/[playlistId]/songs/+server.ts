import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { addSongToPlaylist, LibraryError } from '$lib/server/library/playlists';
import { pickStrings } from '$lib/server/http/validate';

export const POST: RequestHandler = async (event) => {
	const session = requireSession(event);
	const body = await event.request.json().catch(() => null);
	const fields = pickStrings(body, ['videoId'] as const);
	if (!fields) {
		error(400, 'videoId is required');
	}

	const db = getDb(event.platform!.env.DB);
	try {
		await addSongToPlaylist(db, event.params.playlistId, session.userId, fields.videoId);
	} catch (err) {
		if (err instanceof LibraryError) {
			error(err.code === 'not_found' ? 404 : 400, err.message);
		}
		throw err;
	}

	return json({ ok: true }, { status: 201 });
};
