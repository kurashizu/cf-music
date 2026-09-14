import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { isSongInUserLibrary } from '$lib/server/library/playlists';
import { setCachePreference, type CacheType } from '$lib/server/cache/preferences';
import { pickStrings } from '$lib/server/http/validate';

const VALID_CACHE_TYPES = new Set<string>(['lazy', 'pinned']);

/** Sets one song's cache preference (lazy/pinned) for the caller. */
export const PUT: RequestHandler = async (event) => {
	const session = requireSession(event);
	const videoId = event.params.videoId;

	const body = await event.request.json().catch(() => null);
	const fields = pickStrings(body, ['cacheType'] as const);
	if (!fields || !VALID_CACHE_TYPES.has(fields.cacheType)) {
		error(400, 'cacheType must be "lazy" or "pinned"');
	}

	const db = getDb(event.platform!.env.DB);
	const owns = await isSongInUserLibrary(db, session.userId, videoId);
	if (!owns) {
		error(404, 'Song not found in your library');
	}

	await setCachePreference(db, session.userId, videoId, fields.cacheType as CacheType);

	return json({ ok: true });
};
