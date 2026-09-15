import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { parseSmartPlaylistId, getSmartPlaylistSongs } from '$lib/server/library/smart-playlists';
import { getObjectStorage } from '$lib/server/storage/factory';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals, params }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const parsed = parseSmartPlaylistId(decodeURIComponent(params.groupId));
	if (!parsed) error(404, 'Not found');

	const db = getDb(platform!.env.DB);
	const songs = await getSmartPlaylistSongs(db, locals.session.userId, parsed.field, parsed.value);

	const storage = getObjectStorage(platform!.env);
	const songsWithCovers = await Promise.all(
		songs.map(async (song) => ({
			...song,
			coverUrl: song.coverKey ? await storage.presignGetUrl(song.coverKey) : null
		}))
	);

	return { field: parsed.field, value: parsed.value, songs: songsWithCovers };
};
