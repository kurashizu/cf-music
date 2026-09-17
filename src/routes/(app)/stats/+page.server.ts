import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listUserLibrarySongs, listPlaylists } from '$lib/server/library/playlists';
import { listSmartPlaylists } from '$lib/server/library/smart-playlists';
import { getUserQuotaBytes } from '$lib/server/eviction/usage';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const db = getDb(platform!.env.DB);
	const [songs, playlists, smartPlaylists, quotaBytes] = await Promise.all([
		listUserLibrarySongs(db, locals.session.userId),
		listPlaylists(db, locals.session.userId),
		listSmartPlaylists(db, locals.session.userId),
		getUserQuotaBytes(db, locals.session.userId)
	]);
	// usageBytes is just a sum of what listUserLibrarySongs already fetched —
	// getUserStorageUsageBytes would otherwise re-run the exact same
	// playlist_songs⋈playlists⋈songs join a second time for one number.

	// All the other aggregation (totals, top artists, codec breakdown) also
	// happens client-side in +page.svelte from this same flat list — it's
	// already the whole library in one query (same one the storage/search
	// pages use), so there's no reason to duplicate it as several more
	// GROUP BY queries just to get numbers derivable from what's already
	// in hand.
	const usageBytes = songs.reduce((total, song) => total + song.fileSizeBytes, 0);
	return {
		songs: songs.map((s) => ({
			videoId: s.videoId,
			title: s.title,
			artist: s.artist,
			genre: s.genre,
			durationSeconds: s.durationSeconds,
			fileSizeBytes: s.fileSizeBytes,
			codec: s.codec,
			importedAt: s.importedAt,
			playCount: s.playCount,
			lastPlayedAt: s.lastPlayedAt
		})),
		playlistCount: playlists.length,
		smartPlaylistCount: smartPlaylists.length,
		quotaBytes,
		usageBytes
	};
};
