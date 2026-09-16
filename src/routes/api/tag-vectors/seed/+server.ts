import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { seedTagVectors } from '$lib/server/auto-tag/tag-vectors';

interface SeedTagVectorsInput {
	tag: unknown;
	facet: unknown;
	embedding: unknown;
}

function isValidEntry(entry: SeedTagVectorsInput): entry is { tag: string; facet: string; embedding: number[] } {
	return (
		typeof entry.tag === 'string' &&
		typeof entry.facet === 'string' &&
		Array.isArray(entry.embedding) &&
		entry.embedding.every((v) => typeof v === 'number')
	);
}

/**
 * Called by the seed-vocabulary GitHub Actions workflow — a manual,
 * one-off job (the vocabulary itself changes rarely) that embeds every
 * tag in TAG_VOCABULARY via gemini-embedding-2 as plain text, then posts
 * the whole batch here in one request rather than one call per tag: 53
 * tags' worth of 768-float vectors is small (well under any request size
 * limit), and there's no per-tag state to track the way embedding_jobs
 * tracks per-song state, so a single all-or-nothing write is simpler than
 * a claim/complete loop. HMAC-signed the same way as the embedding and
 * import CI callbacks, reusing EMBEDDING_WEBHOOK_SECRET rather than
 * minting a new secret for what's the same "Gemini-vector CI job" family.
 */
export const POST: RequestHandler = async (event) => {
	const rawBody = await event.request.text();
	const signature = event.request.headers.get('X-Signature-256');
	const secret = event.platform!.env.EMBEDDING_WEBHOOK_SECRET;

	const isValid = await verifyWebhookSignature(rawBody, signature, secret);
	if (!isValid) {
		error(401, 'Invalid webhook signature');
	}

	const body: unknown = JSON.parse(rawBody);
	const tags = (body as { tags?: unknown }).tags;
	if (!Array.isArray(tags) || !tags.every(isValidEntry)) {
		error(400, 'tags (array of { tag: string, facet: string, embedding: number[] }) is required');
	}

	const db = getDb(event.platform!.env.DB);
	const result = await seedTagVectors(db, tags);

	return json(result);
};
