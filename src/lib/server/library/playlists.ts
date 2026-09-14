import { eq, and, max } from 'drizzle-orm';
import type { Db } from '../db';
import { playlists, playlistSongs, songs } from '../db/schema';

export class LibraryError extends Error {
	constructor(
		message: string,
		public readonly code: 'not_found' | 'forbidden' | 'song_not_in_library'
	) {
		super(message);
		this.name = 'LibraryError';
	}
}

export interface CreatePlaylistInput {
	userId: string;
	name: string;
	sourceUrl?: string;
}

export async function createPlaylist(db: Db, input: CreatePlaylistInput): Promise<{ id: string }> {
	const id = crypto.randomUUID();
	await db.insert(playlists).values({
		id,
		userId: input.userId,
		name: input.name,
		sourceUrl: input.sourceUrl
	});
	return { id };
}

export async function listPlaylists(db: Db, userId: string) {
	return db.query.playlists.findMany({
		where: eq(playlists.userId, userId),
		orderBy: (t, { desc }) => desc(t.createdAt)
	});
}

/**
 * Whether `videoId` is reachable through any playlist `userId` owns. Used to
 * gate access to a song's presigned URLs — even though songs are globally
 * deduplicated by video_id and may be shared with other users, a user should
 * only ever get a playable link for something in *their own* library.
 */
export async function isSongInUserLibrary(db: Db, userId: string, videoId: string): Promise<boolean> {
	const [row] = await db
		.select({ videoId: playlistSongs.videoId })
		.from(playlistSongs)
		.innerJoin(playlists, eq(playlistSongs.playlistId, playlists.id))
		.where(and(eq(playlists.userId, userId), eq(playlistSongs.videoId, videoId)))
		.limit(1);

	return row !== undefined;
}

/** Fetches a playlist owned by the given user, or throws if missing/not owned. */
async function getOwnedPlaylist(db: Db, playlistId: string, userId: string) {
	const playlist = await db.query.playlists.findFirst({
		where: eq(playlists.id, playlistId)
	});
	if (!playlist) throw new LibraryError('Playlist not found', 'not_found');
	if (playlist.userId !== userId) throw new LibraryError('Playlist not found', 'not_found');
	return playlist;
}

export async function getPlaylistWithSongs(db: Db, playlistId: string, userId: string) {
	const playlist = await getOwnedPlaylist(db, playlistId, userId);

	const entries = await db
		.select({ song: songs, position: playlistSongs.position })
		.from(playlistSongs)
		.innerJoin(songs, eq(playlistSongs.videoId, songs.videoId))
		.where(eq(playlistSongs.playlistId, playlistId))
		.orderBy(playlistSongs.position);

	return { ...playlist, songs: entries.map((e) => e.song) };
}

export async function renamePlaylist(db: Db, playlistId: string, userId: string, name: string): Promise<void> {
	await getOwnedPlaylist(db, playlistId, userId);
	await db.update(playlists).set({ name }).where(eq(playlists.id, playlistId));
}

export async function deletePlaylist(db: Db, playlistId: string, userId: string): Promise<void> {
	await getOwnedPlaylist(db, playlistId, userId);
	// playlist_songs rows cascade-delete; the referenced songs themselves are
	// left untouched here — eviction/cleanup of orphaned songs is a separate
	// concern (see library/eviction.ts), not implied by removing a playlist.
	await db.delete(playlists).where(eq(playlists.id, playlistId));
}

/** Appends a song to the end of a playlist. Assumes the song already exists in `songs`. */
export async function addSongToPlaylist(db: Db, playlistId: string, userId: string, videoId: string): Promise<void> {
	await getOwnedPlaylist(db, playlistId, userId);

	const song = await db.query.songs.findFirst({ where: eq(songs.videoId, videoId) });
	if (!song) throw new LibraryError('Song not found in library', 'song_not_in_library');

	const [{ maxPosition }] = await db
		.select({ maxPosition: max(playlistSongs.position) })
		.from(playlistSongs)
		.where(eq(playlistSongs.playlistId, playlistId));

	await db
		.insert(playlistSongs)
		.values({ playlistId, videoId, position: (maxPosition ?? -1) + 1 })
		.onConflictDoNothing();
}

export async function removeSongFromPlaylist(
	db: Db,
	playlistId: string,
	userId: string,
	videoId: string
): Promise<void> {
	await getOwnedPlaylist(db, playlistId, userId);
	await db
		.delete(playlistSongs)
		.where(and(eq(playlistSongs.playlistId, playlistId), eq(playlistSongs.videoId, videoId)));
}

/**
 * Reorders a playlist to exactly match `orderedVideoIds`. Every video id
 * currently in the playlist must appear exactly once, or the reorder is
 * rejected wholesale (rather than silently dropping/duplicating entries).
 */
export async function reorderPlaylist(
	db: Db,
	playlistId: string,
	userId: string,
	orderedVideoIds: string[]
): Promise<void> {
	await getOwnedPlaylist(db, playlistId, userId);

	const current = await db.query.playlistSongs.findMany({
		where: eq(playlistSongs.playlistId, playlistId)
	});
	const currentIds = new Set(current.map((c) => c.videoId));
	const requestedIds = new Set(orderedVideoIds);

	const sameSet =
		currentIds.size === requestedIds.size && [...currentIds].every((id) => requestedIds.has(id));
	if (!sameSet) {
		throw new LibraryError(
			'Reorder must include exactly the songs currently in the playlist',
			'song_not_in_library'
		);
	}

	for (let position = 0; position < orderedVideoIds.length; position++) {
		await db
			.update(playlistSongs)
			.set({ position })
			.where(and(eq(playlistSongs.playlistId, playlistId), eq(playlistSongs.videoId, orderedVideoIds[position])));
	}
}
