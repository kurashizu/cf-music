import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import {
	removeSongFromPlaylist,
	addSongToPlaylist,
	moveSongToPlaylist,
	LibraryError
} from '$lib/server/library/playlists';
import { pickStrings } from '$lib/server/http/validate';

const VALID_MODES = new Set(['copy', 'move']);

function handleLibraryError(err: unknown): never {
	if (err instanceof LibraryError) {
		if (err.code === 'default_playlist_protected') error(400, err.message);
		error(404, err.message);
	}
	throw err;
}

export const DELETE: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env);

	try {
		await removeSongFromPlaylist(db, event.params.playlistId, session.userId, event.params.videoId);
	} catch (err) {
		handleLibraryError(err);
	}

	return json({ ok: true });
};

/**
 * Copies or moves this song into { toPlaylistId }, per { mode }. Copy
 * (the default) leaves the URL's playlist untouched — the song ends up in
 * both. Move additionally removes it from the URL's playlist, which
 * removeSongFromPlaylist itself refuses when that's the user's default
 * library playlist (see its own guard) — a move out of it fails the same
 * way a plain remove would, rather than silently degrading to a copy.
 */
export const PUT: RequestHandler = async (event) => {
	const session = requireSession(event);

	const body = await event.request.json().catch(() => null);
	const fields = pickStrings(body, ['toPlaylistId'] as const);
	if (!fields) {
		error(400, 'toPlaylistId is required');
	}
	const modeRaw =
		typeof body === 'object' && body !== null ? (body as Record<string, unknown>).mode : undefined;
	const mode = typeof modeRaw === 'string' && VALID_MODES.has(modeRaw) ? modeRaw : 'copy';

	const db = getDb(event.platform!.env);
	try {
		if (mode === 'move') {
			await moveSongToPlaylist(
				db,
				session.userId,
				event.params.playlistId,
				fields.toPlaylistId,
				event.params.videoId
			);
		} else {
			await addSongToPlaylist(db, fields.toPlaylistId, session.userId, event.params.videoId);
		}
	} catch (err) {
		handleLibraryError(err);
	}

	return json({ ok: true });
};
