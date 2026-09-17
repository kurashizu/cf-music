import type { Db } from '../db';
import { songEmbeddings } from '../db/schema';
import { encodeVector } from './vector-codec';

export async function upsertSongEmbedding(db: Db, videoId: string, embedding: number[]): Promise<void> {
	await db
		.insert(songEmbeddings)
		.values({ videoId, vector: Buffer.from(encodeVector(embedding)) })
		.onConflictDoUpdate({
			target: songEmbeddings.videoId,
			set: { vector: Buffer.from(encodeVector(embedding)), updatedAt: new Date().toISOString() }
		});
}
