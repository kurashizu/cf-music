import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { userSongs } from '$lib/server/db/schema';
import { requireSession } from '$lib/server/auth/guard';
import type { RequestHandler } from './$types';

/**
 * This user's play history: how often each song has been played and when
 * it was last played.
 *
 * Read by the browser's cache limit to rank which auto-cached songs to
 * drop (see src/lib/client/cache-limit.ts). Deliberately the same figures
 * cloud eviction ranks on, so a song judged least worth keeping in one
 * place is judged the same way in the other.
 *
 * Only rows that exist: a song is absent until the first time it is
 * played, and the caller already treats absent as never-played. Indexed
 * on user_id (the primary key's own prefix), so this reads only this
 * user's rows.
 */
export const GET: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env);

	const rows = await db
		.select({
			videoId: userSongs.videoId,
			playCount: userSongs.playCount,
			lastPlayedAt: userSongs.lastPlayedAt
		})
		.from(userSongs)
		.where(eq(userSongs.userId, session.userId));

	return json(rows);
};
