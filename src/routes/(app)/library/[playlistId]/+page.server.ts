import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getPlaylistWithSongs, LibraryError } from '$lib/server/library/playlists';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals, params }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const db = getDb(platform!.env.DB);

	try {
		const playlist = await getPlaylistWithSongs(db, params.playlistId, locals.session.userId);
		return { playlist };
	} catch (err) {
		if (err instanceof LibraryError) error(404, err.message);
		throw err;
	}
};
