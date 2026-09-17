import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { markEmbeddingJobDone } from '$lib/server/embedding/jobs';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { pickStrings, pickPositiveNumber } from '$lib/server/http/validate';
import { upsertSongEmbedding } from '$lib/server/embedding/vector-store';
import { recordAuditEvent } from '$lib/server/audit/log';

/**
 * Called by the embedding GitHub Actions workflow once it has computed a
 * song's embedding — writes the vector to D1 and marks the job done.
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
	const fields = pickStrings(body, ['jobId', 'videoId'] as const);
	const embedding = (body as { embedding?: unknown }).embedding;
	if (!fields || !Array.isArray(embedding) || !embedding.every((v) => typeof v === 'number')) {
		error(400, 'jobId, videoId, and embedding (number[]) are required');
	}

	// Details of the Gemini call itself, for the audit trail — not needed
	// for correctness (the vector is already fully formed by the time it
	// gets here), so these are optional rather than validated like the
	// fields above.
	const segmentCount = pickPositiveNumber(body, 'segmentCount');
	const totalAudioSeconds = pickPositiveNumber(body, 'totalAudioSeconds');
	const embedMillis = pickPositiveNumber(body, 'embedMillis');

	const db = getDb(event.platform!.env.DB);
	await upsertSongEmbedding(db, fields.videoId, embedding);
	await markEmbeddingJobDone(db, fields.jobId);

	await recordAuditEvent(db, {
		eventType: 'embedding_completed',
		targetType: 'embedding_job',
		targetId: fields.jobId,
		detail: {
			videoId: fields.videoId,
			dimensions: embedding.length,
			segmentCount,
			totalAudioSeconds,
			embedMillis
		}
	});

	return json({ ok: true });
};
