import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { isSongInUserLibrary } from '$lib/server/library/playlists';
import { recordSongPlay } from '$lib/server/library/plays';

/**
 * Records one real play (see src/lib/shared/playback.ts for the client-side
 * "played long enough to count" threshold — this endpoint trusts the caller
 * to have already applied it, and does not re-derive it from a request body,
 * since duration/currentTime are easy to spoof and the cost of an inflated
 * play count here is low for a private, invite-only app). Scoped to this
 * user's own play history — see recordSongPlay/user_songs for why this
 * can't be a global counter on `songs`.
 */
export const POST: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env);
	const videoId = event.params.videoId;

	const owns = await isSongInUserLibrary(db, session.userId, videoId);
	if (!owns) {
		error(404, 'Song not found in your library');
	}

	await recordSongPlay(db, session.userId, videoId);

	return json({ ok: true });
};
