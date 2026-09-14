import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { playlists, playlistSongs, songs } from '../db/schema';

export type SmartPlaylistField = 'artist' | 'genre';

export interface SmartPlaylistSummary {
	/** e.g. "artist:Radiohead" — the field + raw value, not a random id, since there's no row to look one up from. */
	id: string;
	field: SmartPlaylistField;
	value: string;
	songCount: number;
}

/**
 * Auto-categorized groupings of the user's library by artist/genre —
 * unlike playlists (src/lib/server/library/playlists.ts), these are
 * computed fresh from `songs.artist`/`songs.genre` on every call, not
 * stored anywhere: there's no playlist_songs row to add/remove, no name to
 * rename, no order to reorder. A song with no artist/genre set (most
 * plain YouTube uploads never populate genre, see the schema's own
 * comment) simply doesn't appear in that field's groupings — it's still
 * reachable through whatever real playlist(s) it's actually in.
 */
export async function listSmartPlaylists(db: Db, userId: string): Promise<SmartPlaylistSummary[]> {
	const librarySongs = await db
		.selectDistinct({
			videoId: songs.videoId,
			artist: songs.artist,
			genre: songs.genre
		})
		.from(playlistSongs)
		.innerJoin(playlists, eq(playlistSongs.playlistId, playlists.id))
		.innerJoin(songs, eq(playlistSongs.videoId, songs.videoId))
		.where(eq(playlists.userId, userId));

	const counts = new Map<string, SmartPlaylistSummary>();

	function record(field: SmartPlaylistField, value: string | null) {
		if (!value) return;
		const id = `${field}:${value}`;
		const existing = counts.get(id);
		if (existing) {
			existing.songCount += 1;
		} else {
			counts.set(id, { id, field, value, songCount: 1 });
		}
	}

	for (const song of librarySongs) {
		record('artist', song.artist);
		record('genre', song.genre);
	}

	return [...counts.values()].sort((a, b) => b.songCount - a.songCount || a.value.localeCompare(b.value));
}

/** Parses a SmartPlaylistSummary.id back into its field/value — the inverse of the `${field}:${value}` id above. */
export function parseSmartPlaylistId(id: string): { field: SmartPlaylistField; value: string } | null {
	const separatorIndex = id.indexOf(':');
	if (separatorIndex === -1) return null;

	const field = id.slice(0, separatorIndex);
	const value = id.slice(separatorIndex + 1);
	if ((field !== 'artist' && field !== 'genre') || value.length === 0) return null;

	return { field, value };
}

export interface SmartPlaylistSong {
	videoId: string;
	title: string;
	durationSeconds: number | null;
}

/** Fetches every song in `userId`'s library matching one artist/genre value — the smart-playlist equivalent of getPlaylistWithSongs. */
export async function getSmartPlaylistSongs(
	db: Db,
	userId: string,
	field: SmartPlaylistField,
	value: string
): Promise<SmartPlaylistSong[]> {
	const column = field === 'artist' ? songs.artist : songs.genre;

	return db
		.selectDistinct({
			videoId: songs.videoId,
			title: songs.title,
			durationSeconds: songs.durationSeconds
		})
		.from(playlistSongs)
		.innerJoin(playlists, eq(playlistSongs.playlistId, playlists.id))
		.innerJoin(songs, eq(playlistSongs.videoId, songs.videoId))
		.where(and(eq(playlists.userId, userId), eq(column, value)));
}
