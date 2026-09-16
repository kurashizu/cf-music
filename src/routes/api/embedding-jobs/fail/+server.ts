import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { failEmbeddingJob } from '$lib/server/embedding/jobs';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { pickStrings } from '$lib/server/http/validate';

/**
 * Called by the embedding GitHub Actions workflow when a song's embedding
 * couldn't be produced — see failEmbeddingJob for the retryable vs
 * non-retryable distinction.
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
	const fields = pickStrings(body, ['jobId', 'error'] as const);
	const retryable = (body as { retryable?: unknown }).retryable;
	if (!fields || typeof retryable !== 'boolean') {
		error(400, 'jobId, error, and retryable (boolean) are required');
	}

	const db = getDb(event.platform!.env.DB);
	await failEmbeddingJob(db, { jobId: fields.jobId, error: fields.error, retryable });

	return json({ ok: true });
};
