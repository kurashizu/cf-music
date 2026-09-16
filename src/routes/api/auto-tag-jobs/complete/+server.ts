import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { writeAutoTags, type AutoTagResult } from '$lib/server/auto-tag/jobs';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { recordAuditEvent } from '$lib/server/audit/log';

function isValidResult(entry: unknown): entry is AutoTagResult {
	if (typeof entry !== 'object' || entry === null) return false;
	const { videoId, autoTags } = entry as Record<string, unknown>;
	return (
		typeof videoId === 'string' &&
		typeof autoTags === 'object' &&
		autoTags !== null &&
		Object.values(autoTags).every((v) => typeof v === 'number')
	);
}

/**
 * Called once per auto-tag CI run with the whole batch's computed
 * similarity scores — one request, not one per song, since (unlike
 * embedding) there's no per-song failure mode worth reporting
 * individually; the math can't fail, only a song vanishing between claim
 * and here, which just updates zero rows for that entry.
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
	const results = (body as { results?: unknown }).results;
	if (!Array.isArray(results) || !results.every(isValidResult)) {
		error(400, 'results (array of { videoId: string, autoTags: Record<string, number> }) is required');
	}

	const db = getDb(event.platform!.env.DB);
	await writeAutoTags(db, results);

	await recordAuditEvent(db, {
		eventType: 'auto_tag_completed',
		targetType: 'song',
		detail: { videoIds: results.map((r) => r.videoId), count: results.length }
	});

	return json({ updatedCount: results.length });
};
