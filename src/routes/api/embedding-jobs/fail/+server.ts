import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { failEmbeddingJob } from '$lib/server/embedding/jobs';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { pickStrings } from '$lib/server/http/validate';
import { recordAuditEvent } from '$lib/server/audit/log';

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
	// Optional — older CI runs or the orphaned-job path in claim/+server.ts
	// don't have a videoId handy, and it's not needed for correctness.
	const videoId = (body as { videoId?: unknown }).videoId;

	const db = getDb(event.platform!.env.DB);
	await failEmbeddingJob(db, { jobId: fields.jobId, error: fields.error, retryable });

	await recordAuditEvent(db, {
		eventType: 'embedding_failed',
		targetType: 'embedding_job',
		targetId: fields.jobId,
		detail: {
			videoId: typeof videoId === 'string' ? videoId : null,
			error: fields.error,
			retryable
		}
	});

	return json({ ok: true });
};
