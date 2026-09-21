import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listUserLibrarySongs, listPlaylists } from '$lib/server/library/playlists';
import { getUserQuotaBytes } from '$lib/server/eviction/usage';
import { getObjectStorage } from '$lib/server/storage/factory';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const db = getDb(platform!.env);
	const [songs, quotaBytes, playlists] = await Promise.all([
		listUserLibrarySongs(db, locals.session.userId),
		getUserQuotaBytes(db, locals.session.userId),
		listPlaylists(db, locals.session.userId)
	]);
	// listUserLibrarySongs already reads every distinct song's fileSizeBytes
	// for this page's own table — getUserStorageUsageBytes would just run
	// the exact same playlist_songs⋈playlists⋈songs join a second time to
	// sum a column already sitting right here.
	const usageBytes = songs.reduce((total, song) => total + song.fileSizeBytes, 0);

	const storage = getObjectStorage(platform!.env);
	const entries = await Promise.all(
		songs.map(async (song) => ({
			...song,
			coverUrl: song.coverKey ? await storage.presignGetUrl(song.coverKey) : null
		}))
	);

	return {
		entries,
		quotaBytes,
		usageBytes,
		// This page spans the whole library (every playlist a song might be
		// in), not one specific playlist — "copy to" needs a full list to
		// pick from, unlike the playlist detail page which excludes just
		// the one it's already showing.
		playlists: playlists.map((p) => ({ id: p.id, name: p.name }))
	};
};
