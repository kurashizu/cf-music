import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { getObjectStorage } from '$lib/server/storage/factory';
import { findUnreferencedSongs, resolveUnreferencedSong } from '$lib/server/eviction/orphan-scan';

/**
 * Reports `songs` rows that no playlist_songs row reaches at all — see
 * findUnreferencedSongs.
 */
export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const db = getDb(event.platform!.env.DB);

	return json(await findUnreferencedSongs(db));
};

/**
 * Deletes one unreferenced song the caller specifies — re-checked against a
 * fresh scan first (same reasoning as the orphans/dead-references
 * endpoints' DELETE: a playlist could have picked it back up between the
 * GET report and this call).
 */
export const DELETE: RequestHandler = async (event) => {
	const session = requireAdmin(event);
	const body: unknown = await event.request.json().catch(() => null);
	const videoId =
		typeof body === 'object' && body !== null
			? (body as Record<string, unknown>).videoId
			: undefined;
	if (typeof videoId !== 'string') {
		error(400, 'videoId is required');
	}

	const db = getDb(event.platform!.env.DB);
	const storage = getObjectStorage(event.platform!.env);

	const { unreferencedSongs } = await findUnreferencedSongs(db);
	const stillUnreferenced = unreferencedSongs.find((s) => s.videoId === videoId);
	if (!stillUnreferenced) {
		return json({ resolved: false, reason: 'No longer unreferenced' });
	}

	const { resolved } = await resolveUnreferencedSong(db, storage, session.userId, videoId);
	return json({ resolved, reason: resolved ? undefined : 'Already resolved by another admin' });
};
