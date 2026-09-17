import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { getSimilarSongsInLibrary } from '$lib/server/embedding/similarity';
import { getObjectStorage } from '$lib/server/storage/factory';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * "More like this" — ranks the requesting user's own library by similarity
 * to the given song. See getSimilarSongsInLibrary for why this is a
 * brute-force cosine pass over D1-stored vectors rather than a Vectorize
 * query: it only ever needs to rank within one user's library.
 */
export const GET: RequestHandler = async (event) => {
	const session = requireSession(event);
	const limitParam = Number(event.url.searchParams.get('limit'));
	const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

	const db = getDb(event.platform!.env.DB);
	const results = await getSimilarSongsInLibrary(db, session.userId, event.params.videoId, limit);

	const storage = getObjectStorage(event.platform!.env);
	const songs = await Promise.all(
		results.map(async (song) => ({
			...song,
			coverUrl: song.coverKey ? await storage.presignGetUrl(song.coverKey) : null
		}))
	);

	return json({ songs });
};
