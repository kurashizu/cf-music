import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireSession } from '$lib/server/auth/guard';
import { isSongInUserLibrary } from '$lib/server/library/playlists';
import { getDb } from '$lib/server/db';
import { getObjectStorage } from '$lib/server/storage/factory';
import { evictSongForUser } from '$lib/server/eviction/execute';

/** Manual delete: user-initiated removal of a song from their own library. */
export const DELETE: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env);
	const videoId = event.params.videoId;

	const owns = await isSongInUserLibrary(db, session.userId, videoId);
	if (!owns) {
		error(404, 'Song not found in your library');
	}

	const storage = getObjectStorage(event.platform!.env);
	await evictSongForUser(db, storage, session.userId, videoId, 'manual_delete');

	return json({ ok: true });
};
