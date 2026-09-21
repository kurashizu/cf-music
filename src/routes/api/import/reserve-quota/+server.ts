import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { reserveQuota } from '$lib/server/import/quota-reservations';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { pickStrings } from '$lib/server/http/validate';

/**
 * Called by the GitHub Actions import job right before each song's
 * download starts (not once per whole batch, like the older
 * /api/import/remaining-quota check still run up front for the "does this
 * whole batch even have a chance" case) — see reserveQuota for why doing
 * this per-song, atomically, is what actually prevents two concurrent
 * imports for the same user from both fitting their own estimate against
 * the same stale "remaining" figure and, together, exceeding quota.
 * HMAC-signed like the other CI-facing endpoints — no user session to
 * authenticate with here.
 */
export const POST: RequestHandler = async (event) => {
	const rawBody = await event.request.text();
	const signature = event.request.headers.get('X-Signature-256');
	const secret = event.platform!.env.IMPORT_WEBHOOK_SECRET;

	const isValid = await verifyWebhookSignature(rawBody, signature, secret);
	if (!isValid) {
		error(401, 'Invalid webhook signature');
	}

	const body: unknown = JSON.parse(rawBody);
	const fields = pickStrings(body, ['userId', 'jobId', 'videoId']);
	const estimatedBytes =
		typeof body === 'object' && body !== null
			? (body as Record<string, unknown>).estimatedBytes
			: undefined;
	if (
		!fields ||
		typeof estimatedBytes !== 'number' ||
		!Number.isFinite(estimatedBytes) ||
		estimatedBytes < 0
	) {
		error(400, 'userId, jobId, videoId, and a non-negative numeric estimatedBytes are required');
	}

	const db = getDb(event.platform!.env);
	const result = await reserveQuota(
		db,
		fields.userId,
		fields.jobId,
		fields.videoId,
		estimatedBytes
	);

	return json(result);
};
