import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { embeddingJobs, playlists, playlistSongs, songs, users } from '../db/schema';

/**
 * Songs that have a completed embedding (so a Vectorize entry actually
 * exists for them) but haven't been auto-tagged yet — the set the
 * auto-tag CI job claims each run. Unlike embedding_jobs, there's no
 * separate job/status table for this: `autoTags IS NULL` is itself the
 * complete signal for "needs processing," and every run re-derives this
 * set from scratch rather than tracking a cursor, so a song deleted or
 * re-imported between runs is never stale — see the schema's own comment
 * on autoTags for why a null there specifically means "never processed,"
 * not "processed with no tags."
 */
export async function claimAutoTagCandidates(db: Db): Promise<string[]> {
	const rows = await db
		.select({ videoId: songs.videoId })
		.from(songs)
		.innerJoin(embeddingJobs, eq(embeddingJobs.videoId, songs.videoId))
		.where(and(eq(embeddingJobs.status, 'done'), isNull(songs.autoTags)));

	return rows.map((r) => r.videoId);
}

export interface TagVectorForScoring {
	tag: string;
	facet: string;
	embedding: number[];
}

/**
 * Every tag's own precomputed embedding and facet — the fixed side of
 * the similarity computation, unchanged per run unless the vocabulary
 * itself was re-seeded. facet is only actually used by stage two's own
 * CI script (rebuild_playlists.py, to label each rebuilt playlist with
 * its facet) — stage one's tag_songs.py ignores it and only reads
 * tag/embedding — but both scripts hit this same claim response, so it's
 * simplest to always include it rather than have two near-identical
 * response shapes.
 */
export async function getAllTagVectors(db: Db): Promise<TagVectorForScoring[]> {
	const rows = await db.query.tagVectors.findMany();
	return rows.map((row) => ({
		tag: row.tag,
		facet: row.facet,
		embedding: JSON.parse(row.embedding) as number[]
	}));
}

export interface AutoTagResult {
	videoId: string;
	/** tag -> cosine similarity, one entry per row in tag_vectors — see autoTags' own schema comment for why this isn't pre-filtered. */
	autoTags: Record<string, number>;
}

/**
 * Writes a batch of computed similarity scores back to songs.autoTags —
 * called once per CI run with every claimed song's result, not once per
 * song, since there's no per-song failure mode here worth reporting
 * individually (the similarity math itself can't fail; a song that
 * disappeared between claim and this call just updates zero rows, which
 * is fine).
 */
export async function writeAutoTags(db: Db, results: AutoTagResult[]): Promise<void> {
	for (const { videoId, autoTags } of results) {
		await db.update(songs).set({ autoTags: JSON.stringify(autoTags) }).where(eq(songs.videoId, videoId));
	}
}

// --- Stage two: rebuilding each user's own Auto-tagged playlists ---

/** Every user's id — stage two's CI script loops over this one user at a time, rebuilding that user's own auto_tag playlists before moving to the next. */
export async function listAllUserIds(db: Db): Promise<string[]> {
	const rows = await db.select({ id: users.id }).from(users);
	return rows.map((r) => r.id);
}

export interface LibrarySongAutoTags {
	videoId: string;
	/** null for a song reachable through this user's library that hasn't been auto-tagged yet (see claimAutoTagCandidates) — the rebuild simply can't consider it for any tag until a later run fills this in. */
	autoTags: Record<string, number> | null;
}

/**
 * Every song reachable through userId's own custom playlists (not their
 * system-generated ones, including any auto_tag playlists from a
 * previous rebuild — see this function's own design discussion: what
 * "is this song in the user's library" means for this purpose must not
 * be circular), with each song's autoTags parsed back from JSON.
 */
export async function getUserLibraryAutoTags(db: Db, userId: string): Promise<LibrarySongAutoTags[]> {
	const rows = await db
		.selectDistinct({ videoId: songs.videoId, autoTags: songs.autoTags })
		.from(playlistSongs)
		.innerJoin(playlists, eq(playlistSongs.playlistId, playlists.id))
		.innerJoin(songs, eq(playlistSongs.videoId, songs.videoId))
		.where(and(eq(playlists.userId, userId), eq(playlists.type, 'custom')));

	return rows.map((row) => ({
		videoId: row.videoId,
		autoTags: row.autoTags ? (JSON.parse(row.autoTags) as Record<string, number>) : null
	}));
}

export interface AutoTagPlaylistInput {
	tag: string;
	facet: string;
	videoIds: string[];
}

/**
 * Wholesale-replaces userId's auto_tag playlists: deletes every one this
 * user currently has (cascade-deletes their playlistSongs rows too), then
 * inserts the newly computed set. Deliberately delete-then-insert, not a
 * diff — the whole point of "system-generated, not user-editable" is that
 * nothing here needs to preserve identity (a playlist id, a creation
 * timestamp) across rebuilds; the CI script already decided from scratch
 * which tags qualify (>= 3 songs, per its own z-score threshold) before
 * calling this.
 */
export async function rebuildAutoTagPlaylists(db: Db, userId: string, playlistsInput: AutoTagPlaylistInput[]): Promise<void> {
	await db.delete(playlists).where(and(eq(playlists.userId, userId), eq(playlists.type, 'auto_tag')));

	for (const { tag, facet, videoIds } of playlistsInput) {
		const [{ id: playlistId }] = await db
			.insert(playlists)
			.values({ userId, name: tag, type: 'auto_tag', tag, facet })
			.returning({ id: playlists.id });

		if (videoIds.length === 0) continue;
		await db.insert(playlistSongs).values(
			videoIds.map((videoId, position) => ({ playlistId, videoId, position }))
		);
	}
}

/** How many of a user's own current auto_tag playlists there are — used by the CI script's own audit-log detail, not by the rebuild itself. */
export async function countAutoTagPlaylists(db: Db, userId: string): Promise<number> {
	const [{ count }] = await db
		.select({ count: sql<number>`count(*)` })
		.from(playlists)
		.where(and(eq(playlists.userId, userId), eq(playlists.type, 'auto_tag')));
	return count;
}
