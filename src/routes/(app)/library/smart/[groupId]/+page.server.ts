import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { parseSmartPlaylistId, getSmartPlaylistSongs } from '$lib/server/library/smart-playlists';
import { listPlaylists } from '$lib/server/library/playlists';
import { getObjectStorage } from '$lib/server/storage/factory';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals, params }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const parsed = parseSmartPlaylistId(decodeURIComponent(params.groupId));
	if (!parsed) error(404, 'Not found');

	const db = getDb(platform!.env.DB);
	const [songs, playlists] = await Promise.all([
		getSmartPlaylistSongs(db, locals.session.userId, parsed.field, parsed.value),
		listPlaylists(db, locals.session.userId)
	]);

	const storage = getObjectStorage(platform!.env);
	const songsWithCovers = await Promise.all(
		songs.map(async (song) => ({
			...song,
			coverUrl: song.coverKey ? await storage.presignGetUrl(song.coverKey) : null
		}))
	);

	return {
		field: parsed.field,
		value: parsed.value,
		songs: songsWithCovers,
		// A smart group isn't a real playlist a song could already be "the
		// default" or "in" in the playlist_songs sense — every real
		// playlist is a valid copy/move target, none excluded.
		playlists: playlists.map((p) => ({ id: p.id, name: p.name }))
	};
};
