import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { tagVectors } from '../db/schema';
import { seedTagVectors } from './tag-vectors';

const db = getDb(env.DB);

beforeEach(async () => {
	await db.delete(tagVectors);
});

describe('seedTagVectors', () => {
	it('inserts every tag with its embedding stored as JSON', async () => {
		const result = await seedTagVectors(db, [
			{ tag: 'jazz', facet: 'genre', embedding: [0.1, 0.2, 0.3] },
			{ tag: 'chill', facet: 'mood', embedding: [0.4, 0.5, 0.6] }
		]);

		expect(result.seededCount).toBe(2);

		const rows = await db.query.tagVectors.findMany();
		expect(rows).toHaveLength(2);

		const jazz = rows.find((r) => r.tag === 'jazz');
		expect(jazz?.facet).toBe('genre');
		expect(JSON.parse(jazz!.embedding)).toEqual([0.1, 0.2, 0.3]);
	});

	it('overwrites an existing tag rather than duplicating it, when run again', async () => {
		await seedTagVectors(db, [{ tag: 'jazz', facet: 'genre', embedding: [0.1, 0.2, 0.3] }]);
		await seedTagVectors(db, [{ tag: 'jazz', facet: 'genre', embedding: [0.9, 0.9, 0.9] }]);

		const rows = await db.query.tagVectors.findMany();
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0].embedding)).toEqual([0.9, 0.9, 0.9]);
	});

	it('returns seededCount matching the number of entries passed, not the total table size', async () => {
		await seedTagVectors(db, [{ tag: 'jazz', facet: 'genre', embedding: [0.1] }]);

		const result = await seedTagVectors(db, [{ tag: 'chill', facet: 'mood', embedding: [0.2] }]);

		expect(result.seededCount).toBe(1);
		const rows = await db.query.tagVectors.findMany();
		expect(rows).toHaveLength(2);
	});
});
