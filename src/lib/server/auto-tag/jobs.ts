import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import { embeddingJobs, songs } from '../db/schema';

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
	embedding: number[];
}

/** Every tag's own precomputed embedding — the fixed side of the similarity computation, unchanged per run unless the vocabulary itself was re-seeded. */
export async function getAllTagVectors(db: Db): Promise<TagVectorForScoring[]> {
	const rows = await db.query.tagVectors.findMany();
	return rows.map((row) => ({ tag: row.tag, embedding: JSON.parse(row.embedding) as number[] }));
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
