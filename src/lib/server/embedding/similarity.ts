import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import { playlists, playlistSongs, songEmbeddings } from '../db/schema';
import { chunk } from '../../shared/chunk';
import { decodeVector, cosineSimilarity } from './vector-codec';
import { listUserLibrarySongs, type LibrarySongSummary } from '../library/playlists';

// Same D1 ~100-bound-parameter cap noted in embedding/jobs.ts — this query
// binds 1 param per videoId.
const VIDEO_ID_BATCH_SIZE = 90;

export async function getVectorsByVideoIds(
	db: Db,
	videoIds: string[]
): Promise<Map<string, Float32Array>> {
	if (videoIds.length === 0) return new Map();
	const batches = await Promise.all(
		chunk(videoIds, VIDEO_ID_BATCH_SIZE).map((batch) =>
			db.select().from(songEmbeddings).where(inArray(songEmbeddings.videoId, batch))
		)
	);
	const vectors = new Map<string, Float32Array>();
	for (const row of batches.flat()) {
		vectors.set(row.videoId, decodeVector(row.vector));
	}
	return vectors;
}

/**
 * Every embedding in a user's library (their own playlists), in one query.
 *
 * getVectorsByVideoIds needs a query per 90 ids to stay inside D1's
 * bound-parameter limit — a dozen round trips for a thousand songs, per
 * user, which on a self-hosted database is a dozen of the 50 fetches a
 * Worker may make. Selecting by the playlists that hold them instead binds
 * a single parameter however large the library is.
 */
export async function getVectorsForUserLibrary(
	db: Db,
	userId: string
): Promise<Map<string, Float32Array>> {
	const rows = await db
		.select({ videoId: songEmbeddings.videoId, vector: songEmbeddings.vector })
		.from(songEmbeddings)
		.where(
			inArray(
				songEmbeddings.videoId,
				db
					.select({ videoId: playlistSongs.videoId })
					.from(playlistSongs)
					.innerJoin(playlists, eq(playlistSongs.playlistId, playlists.id))
					.where(and(eq(playlists.userId, userId), eq(playlists.kind, 'user')))
			)
		);
	return new Map(rows.map((row) => [row.videoId, decodeVector(row.vector)]));
}

export interface SimilarSong extends LibrarySongSummary {
	similarity: number;
}

/**
 * Ranks the user's own library by similarity to `seedVideoId`, using
 * embeddings already fetched from D1 rather than a Vectorize ANN search —
 * see the songEmbeddings schema comment for why: this only ever needs to
 * rank within one user's library (a few hundred songs at most), so a
 * brute-force cosine pass in the Worker is both cheap and exact, and avoids
 * paying Vectorize's per-dimension read cost for a query it isn't suited to
 * scope to an arbitrary per-user song set anyway.
 */
export async function getSimilarSongsInLibrary(
	db: Db,
	userId: string,
	seedVideoId: string,
	limit: number
): Promise<SimilarSong[]> {
	const library = await listUserLibrarySongs(db, userId);
	const candidates = library.filter((s) => s.videoId !== seedVideoId);
	if (candidates.length === 0) return [];

	const vectors = await getVectorsByVideoIds(db, [
		seedVideoId,
		...candidates.map((s) => s.videoId)
	]);
	const seedVector = vectors.get(seedVideoId);
	if (!seedVector) return [];

	return candidates
		.map((song) => {
			const vector = vectors.get(song.videoId);
			return vector ? { ...song, similarity: cosineSimilarity(seedVector, vector) } : null;
		})
		.filter((s) => s !== null)
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, limit);
}
