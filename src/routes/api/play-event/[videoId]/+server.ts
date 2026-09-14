import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { songs } from '$lib/server/db/schema';
import { requireSession } from '$lib/server/auth/guard';
import { isSongInUserLibrary } from '$lib/server/library/playlists';

/**
 * Records one real play (see src/lib/shared/playback.ts for the client-side
 * "played long enough to count" threshold — this endpoint trusts the caller
 * to have already applied it, and does not re-derive it from a request body,
 * since duration/currentTime are easy to spoof and the cost of an inflated
 * play count here is low for a private, invite-only app).
 */
export const POST: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env.DB);
	const videoId = event.params.videoId;

	const owns = await isSongInUserLibrary(db, session.userId, videoId);
	if (!owns) {
		error(404, 'Song not found in your library');
	}

	await db
		.update(songs)
		.set({
			playCount: sql`${songs.playCount} + 1`,
			lastPlayedAt: new Date().toISOString()
		})
		.where(eq(songs.videoId, videoId));

	return json({ ok: true });
};
