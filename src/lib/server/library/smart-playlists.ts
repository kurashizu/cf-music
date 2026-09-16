import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { embeddingJobs, playlists, playlistSongs, songs } from '../db/schema';
import { PLAYLIST_MOSAIC_COVER_COUNT } from './playlists';

export interface SmartPlaylistSummary {
	/** e.g. "artist:Radiohead" — the field + raw value, not a random id, since there's no row to look one up from. */
	id: string;
	value: string;
	songCount: number;
	/** Up to PLAYLIST_MOSAIC_COVER_COUNT member songs' coverKeys, for a 2x2 mosaic thumbnail — same idea as playlists' own cover. */
	coverKeys: string[];
}

// Below this many songs, an artist grouping reads as noise rather than a
// useful browsing shortcut (a single-song "artist" card is just that one
// song, redundant with finding it any other way) — so it's excluded from
// the listing entirely rather than shown as a near-empty card.
const MIN_SONGS_PER_ARTIST = 2;

/**
 * Auto-categorized groupings of the user's library by artist — unlike
 * playlists (src/lib/server/library/playlists.ts), these are computed
 * fresh from `songs.artist` on every call, not stored anywhere: there's
 * no playlist_songs row to add/remove, no name to rename, no order to
 * reorder. A song with no artist set simply doesn't appear in any
 * grouping — it's still reachable through whatever real playlist(s) it's
 * actually in.
 */
export async function listSmartPlaylists(db: Db, userId: string): Promise<SmartPlaylistSummary[]> {
	const librarySongs = await db
		.selectDistinct({
			videoId: songs.videoId,
			artist: songs.artist,
			coverKey: songs.coverKey
		})
		.from(playlistSongs)
		.innerJoin(playlists, eq(playlistSongs.playlistId, playlists.id))
		.innerJoin(songs, eq(playlistSongs.videoId, songs.videoId))
		.where(eq(playlists.userId, userId));

	const counts = new Map<string, SmartPlaylistSummary>();

	for (const song of librarySongs) {
		if (!song.artist) continue;
		const id = `artist:${song.artist}`;
		const existing = counts.get(id);
		if (existing) {
			existing.songCount += 1;
			if (song.coverKey && existing.coverKeys.length < PLAYLIST_MOSAIC_COVER_COUNT) {
				existing.coverKeys.push(song.coverKey);
			}
		} else {
			counts.set(id, {
				id,
				value: song.artist,
				songCount: 1,
				coverKeys: song.coverKey ? [song.coverKey] : []
			});
		}
	}

	return [...counts.values()]
		.filter((group) => group.songCount >= MIN_SONGS_PER_ARTIST)
		.sort((a, b) => b.songCount - a.songCount || a.value.localeCompare(b.value));
}

/** Parses a SmartPlaylistSummary.id back into its artist value — the inverse of the `artist:${value}` id above. */
export function parseSmartPlaylistId(id: string): { value: string } | null {
	const prefix = 'artist:';
	if (!id.startsWith(prefix)) return null;

	const value = id.slice(prefix.length);
	if (value.length === 0) return null;

	return { value };
}

export interface SmartPlaylistSong {
	videoId: string;
	title: string;
	durationSeconds: number | null;
	codec: string;
	bitrateKbps: number | null;
	coverKey: string | null;
	/** null when no embedding_jobs row exists yet (e.g. a song imported before the pipeline, not yet backfilled) — treated the same as any non-'done' status: not embedded. */
	embeddingStatus: string | null;
}

/** Fetches every song in `userId`'s library by one artist — the smart-playlist equivalent of getPlaylistWithSongs. */
export async function getSmartPlaylistSongs(db: Db, userId: string, value: string): Promise<SmartPlaylistSong[]> {
	return db
		.selectDistinct({
			videoId: songs.videoId,
			title: songs.title,
			durationSeconds: songs.durationSeconds,
			codec: songs.codec,
			bitrateKbps: songs.bitrateKbps,
			coverKey: songs.coverKey,
			embeddingStatus: embeddingJobs.status
		})
		.from(playlistSongs)
		.innerJoin(playlists, eq(playlistSongs.playlistId, playlists.id))
		.innerJoin(songs, eq(playlistSongs.videoId, songs.videoId))
		.leftJoin(embeddingJobs, eq(embeddingJobs.videoId, songs.videoId))
		.where(and(eq(playlists.userId, userId), eq(songs.artist, value)));
}
