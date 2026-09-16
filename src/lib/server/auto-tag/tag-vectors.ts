import { sql } from 'drizzle-orm';
import type { Db } from '../db';
import { tagVectors } from '../db/schema';

export interface TagVectorEntry {
	tag: string;
	facet: string;
	embedding: number[];
}

export interface SeedTagVectorsResult {
	seededCount: number;
}

/**
 * Upserts a batch of pre-embedded tag vectors into tag_vectors — the
 * actual embedding call happens in the seed-vocabulary CI script (see
 * .github/scripts/auto-tag/seed_vocabulary.py), not here; this just
 * writes whatever it's handed. Safe to run repeatedly since each tag is
 * keyed by its own text and overwritten in place, not appended.
 */
export async function seedTagVectors(db: Db, entries: TagVectorEntry[]): Promise<SeedTagVectorsResult> {
	for (const { tag, facet, embedding } of entries) {
		await db
			.insert(tagVectors)
			.values({ tag, facet, embedding: JSON.stringify(embedding) })
			.onConflictDoUpdate({
				target: tagVectors.tag,
				set: { facet, embedding: JSON.stringify(embedding), createdAt: sql`(current_timestamp)` }
			});
	}

	return { seededCount: entries.length };
}
