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
		const vectors = await this.index.getByIds(videoIds);
		return new Map(vectors.map((v) => [v.id, Array.from(v.values)]));
	}
}

export function getVectorStore(env: Env): VectorStore {
	return new VectorizeSongStore(env.VECTORIZE);
}
