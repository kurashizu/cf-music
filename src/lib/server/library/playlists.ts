import { eq, and, isNull, max, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import { playlists, playlistSongs, songs, users, importJobs } from '../db/schema';

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

/**
 * Every import needs a target playlist — songs aren't allowed to exist
 * without being reachable through at least one of a user's playlists
 * (isSongInUserLibrary, storage usage, and eviction all assume that). This
 * returns the user's existing default playlist, or creates one on first
 * use if they've never had one (either never imported without picking a
 * target, or previously deleted their default — see the users table's
 * defaultPlaylistId column for why that's a set-null, not a hard failure).
 */
export async function ensureDefaultPlaylist(db: Db, userId: string): Promise<{ id: string }> {
	const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
	if (user?.defaultPlaylistId) {
		return { id: user.defaultPlaylistId };
	}

	const { id } = await createPlaylist(db, { userId, name: 'Imports' });

	// Two concurrent calls (double-clicking Import, two tabs) can both
	// reach here having both read defaultPlaylistId as null — the WHERE
	// clause below is what actually resolves that: it only writes if the
	// column is *still* null by the time this specific call's UPDATE runs,
	// so whichever call's playlist gets there first wins, and the other's
	// createPlaylist above becomes an unreferenced-but-harmless playlist
	// (empty, never linked as anyone's default) rather than silently
	// overwriting the first winner's id. Re-reading afterward is what lets
	// every caller converge on that same winning id instead of each
	// trusting its own just-created one.
	await db
		.update(users)
		.set({ defaultPlaylistId: id })
		.where(and(eq(users.id, userId), isNull(users.defaultPlaylistId)));

	const resolved = await db.query.users.findFirst({ where: eq(users.id, userId) });
	return { id: resolved!.defaultPlaylistId! };
}

export interface PlaylistSummary {
	id: string;
	userId: string;
	name: string;
	sourceUrl: string | null;
	createdAt: string;
	/** First song's coverKey in playlist order, or null if empty/no covers — the playlist's auto-generated thumbnail. */
	coverKey: string | null;
}

export async function listPlaylists(db: Db, userId: string): Promise<PlaylistSummary[]> {
	const rows = await db.query.playlists.findMany({
		where: eq(playlists.userId, userId),
		orderBy: (t, { desc }) => desc(t.createdAt)
	});
	if (rows.length === 0) return [];

	// One song per playlist (lowest position, i.e. first in play order) to
	// use as an auto-generated thumbnail — playlists have no cover of their
	// own, only songs do.
	const coverRows = await db
		.select({
			playlistId: playlistSongs.playlistId,
			coverKey: songs.coverKey,
			position: playlistSongs.position
		})
		.from(playlistSongs)
		.innerJoin(songs, eq(playlistSongs.videoId, songs.videoId))
		.where(inArray(playlistSongs.playlistId, rows.map((p) => p.id)));

	const firstCoverByPlaylist = new Map<string, { coverKey: string | null; position: number }>();
	for (const row of coverRows) {
		const existing = firstCoverByPlaylist.get(row.playlistId);
		if (!existing || row.position < existing.position) {
			firstCoverByPlaylist.set(row.playlistId, { coverKey: row.coverKey, position: row.position });
		}
	}

	return rows.map((playlist) => ({
		...playlist,
		coverKey: firstCoverByPlaylist.get(playlist.id)?.coverKey ?? null
	}));
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

export interface LibrarySongSummary {
	videoId: string;
	title: string;
	fileSizeBytes: number;
}

/** Every distinct song reachable through any of userId's playlists — the storage management page's song list. */
export async function listUserLibrarySongs(db: Db, userId: string): Promise<LibrarySongSummary[]> {
	return db
		.selectDistinct({
			videoId: songs.videoId,
			title: songs.title,
			fileSizeBytes: songs.fileSizeBytes
		})
		.from(playlistSongs)
		.innerJoin(playlists, eq(playlistSongs.playlistId, playlists.id))
		.innerJoin(songs, eq(playlistSongs.videoId, songs.videoId))
		.where(eq(playlists.userId, userId));
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

	// The schema declares defaultPlaylistId's FK as ON DELETE SET NULL, but
	// SQLite's ALTER TABLE ADD COLUMN can't actually attach that behavior
	// (only CREATE TABLE can) — so without clearing it explicitly here
	// first, deleting a user's own default playlist would fail outright
	// with a foreign key constraint error instead of the intended
	// "next import without a target just creates a new one" behavior.
	await db
		.update(users)
		.set({ defaultPlaylistId: null })
		.where(and(eq(users.id, userId), eq(users.defaultPlaylistId, playlistId)));

	// Same story for import_jobs.target_playlist_id: it has no ON DELETE
	// behavior at all (the column predates any FK action being added), so
	// deleting a playlist any import job ever targeted would otherwise
	// fail outright with a foreign key constraint error. The job's own
	// history (status, counts, failures) is still meaningful without a
	// live playlist to point at, so this nulls it out rather than blocking
	// the delete.
	await db
		.update(importJobs)
		.set({ targetPlaylistId: null })
		.where(eq(importJobs.targetPlaylistId, playlistId));

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
