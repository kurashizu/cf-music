import { eq, and, isNull, max, inArray, sql, exists } from 'drizzle-orm';
import type { Db } from '../db';
import { playlists, playlistSongs, songs, users, importJobs, userSongs, embeddingJobs } from '../db/schema';

export class LibraryError extends Error {
	constructor(
		message: string,
		public readonly code: 'not_found' | 'forbidden' | 'song_not_in_library' | 'default_playlist_protected'
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

	const { id } = await createPlaylist(db, { userId, name: 'All Imported' });

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

/** The user's default playlist id, or null if they've never imported anything yet (no auto-create, unlike ensureDefaultPlaylist). */
async function getDefaultPlaylistId(db: Db, userId: string): Promise<string | null> {
	const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
	return user?.defaultPlaylistId ?? null;
}

export const PLAYLIST_MOSAIC_COVER_COUNT = 4;

export interface PlaylistSummary {
	id: string;
	userId: string;
	name: string;
	sourceUrl: string | null;
	createdAt: string;
	/** Up to PLAYLIST_MOSAIC_COVER_COUNT songs' coverKeys, in playlist order, for a 2x2 mosaic thumbnail — empty if the playlist has no songs with covers. */
	coverKeys: string[];
}

export interface PlaylistRow {
	id: string;
	userId: string;
	name: string;
	sourceUrl: string | null;
	createdAt: string;
}

/**
 * Just the playlist rows themselves — id/name/etc, no member songs. Most
 * callers (the sidebar layout on every single page, playlist/smart-group
 * detail pages, stats, storage settings) only ever need this much; only the
 * library grid's own mosaic thumbnails need coverKeys, which is why that's
 * a separate, heavier call (listPlaylistsWithCovers) instead of bolted onto
 * every caller here. The mosaic join used to run unconditionally inside
 * this function — on every navigation, since the (app) layout calls this —
 * which was reading the user's entire playlist_songs↔songs join on every
 * page view for a result nobody but the library grid displayed.
 */
export async function listPlaylists(db: Db, userId: string): Promise<PlaylistRow[]> {
	return db.query.playlists.findMany({
		where: eq(playlists.userId, userId),
		orderBy: (t, { desc }) => desc(t.createdAt)
	});
}

/** listPlaylists, plus up to PLAYLIST_MOSAIC_COVER_COUNT member songs' coverKeys per playlist for a 2x2 mosaic thumbnail — see listPlaylists for why this is kept separate. */
export async function listPlaylistsWithCovers(db: Db, userId: string): Promise<PlaylistSummary[]> {
	const rows = await listPlaylists(db, userId);
	if (rows.length === 0) return [];

	// Only ever need the first PLAYLIST_MOSAIC_COVER_COUNT non-null covers
	// per playlist, by position — this used to fetch every song in every
	// playlist just to slice down to 4 in JS, which meant a 365-song
	// playlist cost 365 rows read for a 4-cover thumbnail. The window
	// function ranks each playlist's covered songs by position and the
	// outer query only keeps the top N, so D1 only ever returns (and only
	// needs to have read) a handful of rows per playlist.
	const coverRows = await db.all<{ playlistId: string; coverKey: string }>(sql`
		select "playlist_id" as "playlistId", "cover_key" as "coverKey"
		from (
			select
				${playlistSongs.playlistId} as "playlist_id",
				${songs.coverKey} as "cover_key",
				row_number() over (
					partition by ${playlistSongs.playlistId}
					order by ${playlistSongs.position}
				) as "rank"
			from ${playlistSongs}
			inner join ${songs} on ${playlistSongs.videoId} = ${songs.videoId}
			where ${inArray(playlistSongs.playlistId, rows.map((p) => p.id))}
				and ${songs.coverKey} is not null
		) ranked
		where "rank" <= ${PLAYLIST_MOSAIC_COVER_COUNT}
	`);

	const coverKeysByPlaylist = new Map<string, string[]>();
	for (const row of coverRows) {
		const existing = coverKeysByPlaylist.get(row.playlistId);
		if (existing) existing.push(row.coverKey);
		else coverKeysByPlaylist.set(row.playlistId, [row.coverKey]);
	}

	return rows.map((playlist) => ({
		...playlist,
		coverKeys: coverKeysByPlaylist.get(playlist.id) ?? []
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
	artist: string | null;
	genre: string | null;
	durationSeconds: number | null;
	fileSizeBytes: number;
	coverKey: string | null;
	codec: string;
	importedAt: string;
	playCount: number;
	lastPlayedAt: string | null;
}

/**
 * Every distinct song reachable through any of userId's playlists — the
 * storage management page's song list, and the library homepage's global
 * search/filter. userSongs is left-joined (not inner-joined) for
 * playCount/lastPlayedAt: that table only gains a row on a song's first
 * play event (see plays.ts), so a freshly imported, never-played song has
 * no userSongs row at all yet — an inner join would silently drop it from
 * this whole list rather than just reporting it as never played.
 *
 * Starts from `songs` filtered by an EXISTS against playlist_songs⋈playlists,
 * not from playlistSongs itself — joining from playlistSongs fans out once
 * per playlist a song belongs to (a song in both "All Imported" and a
 * user-made playlist would join twice), and D1 bills for rows read during
 * that fan-out even though selectDistinct collapses it back down afterward.
 * EXISTS only ever needs to find one matching playlist_songs row per song,
 * not enumerate every one, so each song is evaluated exactly once.
 */
export async function listUserLibrarySongs(db: Db, userId: string): Promise<LibrarySongSummary[]> {
	const rows = await db
		.select({
			videoId: songs.videoId,
			title: songs.title,
			artist: songs.artist,
			genre: songs.genre,
			durationSeconds: songs.durationSeconds,
			fileSizeBytes: songs.fileSizeBytes,
			coverKey: songs.coverKey,
			codec: songs.codec,
			importedAt: songs.importedAt,
			playCount: userSongs.playCount,
			lastPlayedAt: userSongs.lastPlayedAt
		})
		.from(songs)
		.leftJoin(userSongs, and(eq(userSongs.userId, userId), eq(userSongs.videoId, songs.videoId)))
		.where(
			exists(
				db
					.select({ one: sql`1` })
					.from(playlistSongs)
					.innerJoin(playlists, eq(playlistSongs.playlistId, playlists.id))
					.where(and(eq(playlists.userId, userId), eq(playlistSongs.videoId, songs.videoId)))
			)
		);
	return rows.map((row) => ({ ...row, playCount: row.playCount ?? 0 }));
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

/** Just the playlist row itself plus its total song count — cheap, O(1) metadata for a page's header, not the (potentially hundreds of rows) song list itself. See getPlaylistSongsInRange for that. */
export async function getPlaylistMeta(db: Db, playlistId: string, userId: string) {
	const playlist = await getOwnedPlaylist(db, playlistId, userId);
	const [{ count }] = await db
		.select({ count: sql<number>`count(*)` })
		.from(playlistSongs)
		.where(eq(playlistSongs.playlistId, playlistId));
	return { ...playlist, songCount: count };
}

export type PlaylistSongRow = typeof songs.$inferSelect & {
	addedAt: string;
	embeddingStatus: string | null;
};

/**
 * A page's worth of full song rows (title, artist, duration, cover key,
 * everything the UI renders a row from) by position order — only the
 * playlist detail page's own first-screen window is fetched server-side
 * on load (see INITIAL_PRESIGN_COUNT in +page.server.ts); everything past
 * that, and anything a search/sort/filter needs beyond what's already been
 * fetched, is pulled through this same range query on demand from the
 * client instead of the whole playlist being read into memory up front.
 */
export async function getPlaylistSongsInRange(
	db: Db,
	playlistId: string,
	userId: string,
	offset: number,
	limit: number
): Promise<PlaylistSongRow[]> {
	await getOwnedPlaylist(db, playlistId, userId);

	const entries = await db
		.select({
			song: songs,
			addedAt: playlistSongs.addedAt,
			embeddingStatus: embeddingJobs.status
		})
		.from(playlistSongs)
		.innerJoin(songs, eq(playlistSongs.videoId, songs.videoId))
		.leftJoin(embeddingJobs, eq(embeddingJobs.videoId, songs.videoId))
		.where(eq(playlistSongs.playlistId, playlistId))
		.orderBy(playlistSongs.position)
		.limit(limit)
		.offset(offset);

	// embeddingStatus is null when no embedding_jobs row exists yet (e.g. a
	// song imported before the pipeline, not yet backfilled) — treated the
	// same as any non-'done' status: not embedded.
	return entries.map((e) => ({ ...e.song, addedAt: e.addedAt, embeddingStatus: e.embeddingStatus }));
}

export async function renamePlaylist(db: Db, playlistId: string, userId: string, name: string): Promise<void> {
	await getOwnedPlaylist(db, playlistId, userId);

	// Same reasoning as the delete guard below: this is the one playlist
	// guaranteed to hold the user's whole library, not an arbitrary
	// user-named list — its name is fixed for the same reason its
	// membership can't be edited by removing songs from it.
	if (playlistId === (await getDefaultPlaylistId(db, userId))) {
		throw new LibraryError('The default library playlist cannot be renamed', 'default_playlist_protected');
	}

	await db.update(playlists).set({ name }).where(eq(playlists.id, playlistId));
}

export async function deletePlaylist(db: Db, playlistId: string, userId: string): Promise<void> {
	await getOwnedPlaylist(db, playlistId, userId);

	// The default playlist is the one place a user's whole library is
	// guaranteed reachable from (every import links into it — see
	// linkImportedSongToLibrary in import/jobs.ts) — deleting it would
	// either orphan every song still only reachable through it, or force
	// picking an arbitrary replacement. Neither is a real "delete this
	// playlist" the user asked for, so it's simply not allowed.
	if (playlistId === (await getDefaultPlaylistId(db, userId))) {
		throw new LibraryError('The default library playlist cannot be deleted', 'default_playlist_protected');
	}

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

	// The default playlist has to contain every song the user's ever
	// imported (see linkImportedSongToLibrary) — removing one from just
	// this one playlist would break that guarantee. Deleting the song from
	// the whole library (see evictSongForUser) is the only way to make it
	// disappear from here.
	if (playlistId === (await getDefaultPlaylistId(db, userId))) {
		throw new LibraryError(
			'Cannot remove a song from the default library playlist — delete it from your library instead',
			'default_playlist_protected'
		);
	}

	await db
		.delete(playlistSongs)
		.where(and(eq(playlistSongs.playlistId, playlistId), eq(playlistSongs.videoId, videoId)));
}

/**
 * Moves a song from one playlist to another, both owned by the same
 * user — adds it to the target first (so a failure partway through leaves
 * the song still reachable rather than vanishing from both), then removes
 * it from the source via removeSongFromPlaylist, which is what actually
 * rejects moving *out of* the default playlist (see its own guard).
 */
export async function moveSongToPlaylist(
	db: Db,
	userId: string,
	fromPlaylistId: string,
	toPlaylistId: string,
	videoId: string
): Promise<void> {
	await addSongToPlaylist(db, toPlaylistId, userId, videoId);
	await removeSongFromPlaylist(db, fromPlaylistId, userId, videoId);
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
	const currentPositionByVideoId = new Map(current.map((c) => [c.videoId, c.position]));
	const requestedIds = new Set(orderedVideoIds);

	const sameSet =
		currentPositionByVideoId.size === requestedIds.size &&
		[...currentPositionByVideoId.keys()].every((id) => requestedIds.has(id));
	if (!sameSet) {
		throw new LibraryError(
			'Reorder must include exactly the songs currently in the playlist',
			'song_not_in_library'
		);
	}

	// A drag-to-reorder always resends every song's new position, but only
	// the ones actually between the drag's start and end index ever change —
	// writing the rest back unchanged used to cost one full-playlist-length
	// batch of UPDATEs (and D1 bills by rows written) for what's usually a
	// single-item move.
	for (let position = 0; position < orderedVideoIds.length; position++) {
		const videoId = orderedVideoIds[position];
		if (currentPositionByVideoId.get(videoId) === position) continue;
		await db
			.update(playlistSongs)
			.set({ position })
			.where(and(eq(playlistSongs.playlistId, playlistId), eq(playlistSongs.videoId, videoId)));
	}
}
