/**
 * Thin wrapper around the Vectorize binding, kept behind an interface for
 * the same reason as ObjectStorage in storage/s3.ts — business logic can be
 * tested with a fake instead of needing a real Vectorize index.
 */
export interface VectorStore {
	upsertSongEmbedding(videoId: string, embedding: number[]): Promise<void>;
}

export class VectorizeSongStore implements VectorStore {
	constructor(private readonly index: VectorizeIndex) {}

	async upsertSongEmbedding(videoId: string, embedding: number[]): Promise<void> {
		await this.index.upsert([{ id: videoId, values: embedding }]);
	}
}

export function getVectorStore(env: Env): VectorStore {
	return new VectorizeSongStore(env.VECTORIZE);
}
