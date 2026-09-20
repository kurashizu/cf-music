import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { listPlaylistMemberships } from '$lib/server/library/playlists';
import type { RequestHandler } from './$types';

/**
 * The shape of the user's library: every playlist and the songs in it.
 *
 * Exists so the client can cache the structure for offline use — without it,
 * a device with no connection can only show one flat list of whatever audio
 * happens to be cached, losing the playlists entirely.
 */
export const GET: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env.DB);
	const playlists = await listPlaylistMemberships(db, session.userId);
	return json({ playlists });
};
