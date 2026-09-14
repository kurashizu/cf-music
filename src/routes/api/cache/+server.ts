import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { listCachePreferences } from '$lib/server/cache/preferences';

/** Lists every song in the caller's library with its cache preference (lazy/pinned). */
export const GET: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env.DB);

	return json(await listCachePreferences(db, session.userId));
};
