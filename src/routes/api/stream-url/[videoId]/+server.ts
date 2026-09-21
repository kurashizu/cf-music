import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { songs } from '$lib/server/db/schema';
import { requireSession } from '$lib/server/auth/guard';
import { isSongInUserLibrary } from '$lib/server/library/playlists';
import { getObjectStorage } from '$lib/server/storage/factory';
import { PRESIGNED_URL_EXPIRY_SECONDS } from '$lib/server/storage/s3';

/**
 * Signs a fresh URL for this song's audio (and cover, if present) on every
 * call — deliberately NOT tied to play-event recording (see
 * /api/play-event/[videoId]), so fetching a URL never counts as a play.
 */
export const GET: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env);
	const videoId = event.params.videoId;

	const owns = await isSongInUserLibrary(db, session.userId, videoId);
	if (!owns) {
		error(404, 'Song not found in your library');
	}

	const song = await db.query.songs.findFirst({ where: eq(songs.videoId, videoId) });
	if (!song) {
		error(404, 'Song not found in your library');
	}

	const storage = getObjectStorage(event.platform!.env);
	const [audioUrl, coverUrl] = await Promise.all([
		storage.presignGetUrl(song.audioKey),
		song.coverKey ? storage.presignGetUrl(song.coverKey) : Promise.resolve(null)
	]);

	return json({
		audioUrl,
		coverUrl,
		expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
		codec: song.codec,
		bitrateKbps: song.bitrateKbps,
		sampleRate: song.sampleRate
	});
};
