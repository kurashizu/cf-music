import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { addSongToPlaylist, getPlaylistSongCoverKeysInRange, LibraryError } from '$lib/server/library/playlists';
import { getObjectStorage } from '$lib/server/storage/factory';
import { pickStrings } from '$lib/server/http/validate';

const MAX_RANGE_LIMIT = 100; // generous over the client's own page size (20) — just a sanity cap, not a real pagination limit

/**
 * On-demand cover presigning for songs past the playlist page's own
 * initial window — see INITIAL_PRESIGN_COUNT in +page.server.ts for why
 * the full playlist isn't presigned up front. Called by the playlist
 * page's loadMore() as the user scrolls past what was already presigned
 * server-side on first load.
 */
export const GET: RequestHandler = async (event) => {
	const session = requireSession(event);

	const offsetParam = Number(event.url.searchParams.get('offset'));
	const limitParam = Number(event.url.searchParams.get('limit'));
	if (!Number.isInteger(offsetParam) || offsetParam < 0 || !Number.isInteger(limitParam) || limitParam <= 0) {
		error(400, 'offset (>= 0) and limit (> 0) query params are required');
	}
	const limit = Math.min(limitParam, MAX_RANGE_LIMIT);

	const db = getDb(event.platform!.env.DB);
	let rows;
	try {
		rows = await getPlaylistSongCoverKeysInRange(db, event.params.playlistId, session.userId, offsetParam, limit);
	} catch (err) {
		if (err instanceof LibraryError) error(404, err.message);
		throw err;
	}

	const storage = getObjectStorage(event.platform!.env);
	const covers = await Promise.all(
		rows.map(async (row) => ({
			videoId: row.videoId,
			coverUrl: row.coverKey ? await storage.presignGetUrl(row.coverKey) : null
		}))
	);

	return json({ covers });
};

export const POST: RequestHandler = async (event) => {
	const session = requireSession(event);
	const body = await event.request.json().catch(() => null);
	const fields = pickStrings(body, ['videoId'] as const);
	if (!fields) {
		error(400, 'videoId is required');
	}

	const db = getDb(event.platform!.env.DB);
	try {
		await addSongToPlaylist(db, event.params.playlistId, session.userId, fields.videoId);
	} catch (err) {
		if (err instanceof LibraryError) {
			error(err.code === 'not_found' ? 404 : 400, err.message);
		}
		throw err;
	}

	return json({ ok: true }, { status: 201 });
};
