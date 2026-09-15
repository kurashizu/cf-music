import { d1Execute, seedInviteCode } from './global-setup';

let counter = 0;

// Unique per-call so parallel-unsafe shared state (usernames, invite codes)
// never collides across tests, even though the suite runs with workers: 1.
export function uniqueSuffix(): string {
	counter += 1;
	return `${Date.now()}-${counter}`;
}

export function issueInviteCode(): string {
	const code = `e2e-code-${uniqueSuffix()}`;
	seedInviteCode(code);
	return code;
}

/**
 * Promotes an already-registered user to admin directly in D1 — there's no
 * user-facing "grant admin" API (deliberately: it's an operator concern,
 * not something the app exposes), so this is the correct way to set up an
 * admin-only test rather than reaching around auth entirely.
 */
export function promoteToAdmin(userId: string): void {
	d1Execute(`UPDATE users SET is_admin = 1 WHERE id = '${userId}';`);
}

export interface SeededTrack {
	videoId: string;
	title: string;
	durationSeconds: number;
}

/**
 * Seeds a playlist with songs directly in D1 for a user that has already
 * registered (there's no import UI yet, so this stands in for it). Song
 * video_ids are prefixed `e2e-song-` so global-setup's cleanup can find them.
 */
export function seedPlaylistWithSongs(userId: string, playlistId: string, playlistName: string, trackCount: number): SeededTrack[] {
	const tracks: SeededTrack[] = Array.from({ length: trackCount }, (_, i) => ({
		videoId: `e2e-song-${uniqueSuffix()}-${i}`,
		title: `E2E Track ${i + 1}`,
		durationSeconds: 30 + i * 15
	}));

	d1Execute(
		`INSERT INTO playlists (id, user_id, name, created_at) VALUES ('${playlistId}', '${userId}', '${playlistName}', datetime('now'));`
	);

	for (const track of tracks) {
		d1Execute(
			`INSERT INTO songs (video_id, source_platform, source_url, title, duration_seconds, audio_key, codec, container, bitrate_kbps, sample_rate, file_size_bytes, imported_at)
			 VALUES ('${track.videoId}', 'youtube', 'https://example.com/${track.videoId}', '${track.title}', ${track.durationSeconds}, 'audio/${track.videoId}.webm', 'opus', 'webm', 8, 8000, 2000, datetime('now'));`
		);
	}

	if (tracks.length > 0) {
		const values = tracks
			.map((track, index) => `('${playlistId}', '${track.videoId}', ${index}, datetime('now'))`)
			.join(', ');
		d1Execute(`INSERT INTO playlist_songs (playlist_id, video_id, position, added_at) VALUES ${values};`);
	}

	return tracks;
}
