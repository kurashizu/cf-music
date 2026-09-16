import { chunk } from '../../shared/chunk';

// Vectorize's own getByIds caps a single call at 20 ids (confirmed live:
// "VECTOR_GET_ERROR (code = 40007): too many ids in payload; max id count
// is 20" for a 92-id request) — an entirely different limit from D1's own
// ~100-bound-parameter cap (see chunk.ts's own docstring), so this can't
// reuse that constant even though the shape of the problem is identical.
const VECTORIZE_GET_BY_IDS_BATCH_SIZE = 20;

/**
 * Thin wrapper around the Vectorize binding, kept behind an interface for
 * the same reason as ObjectStorage in storage/s3.ts — business logic can be
 * tested with a fake instead of needing a real Vectorize index.
 */
export interface VectorStore {
	upsertSongEmbedding(videoId: string, embedding: number[]): Promise<void>;
	/** Fetches embeddings by videoId — a plain lookup, not a similarity query. Missing ids are silently omitted from the result, not errored on (e.g. a videoId claimed for auto-tagging whose embedding job hasn't actually written to Vectorize yet). */
	getSongEmbeddings(videoIds: string[]): Promise<Map<string, number[]>>;
}

export class VectorizeSongStore implements VectorStore {
	constructor(private readonly index: VectorizeIndex) {}

	async upsertSongEmbedding(videoId: string, embedding: number[]): Promise<void> {
		await this.index.upsert([{ id: videoId, values: embedding }]);
	}

	async getSongEmbeddings(videoIds: string[]): Promise<Map<string, number[]>> {
		if (videoIds.length === 0) return new Map();

		const result = new Map<string, number[]>();
		for (const batch of chunk(videoIds, VECTORIZE_GET_BY_IDS_BATCH_SIZE)) {
			const vectors = await this.index.getByIds(batch);
			for (const v of vectors) result.set(v.id, Array.from(v.values));
		}
		return result;
	}
}

export function getVectorStore(env: Env): VectorStore {
	return new VectorizeSongStore(env.VECTORIZE);
}
