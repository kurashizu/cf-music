import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { findKnownVideoIds } from '$lib/server/import/jobs';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { pickStringArray } from '$lib/server/http/validate';

/**
 * Called by the GitHub Actions import job before downloading anything, so
 * it can skip video ids already present in the songs table. HMAC-signed
 * like the /events callback — CI has no user session to authenticate with.
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
	const videoIds = pickStringArray(body, 'videoIds');
	if (!videoIds) {
		error(400, 'videoIds must be an array of strings');
	}

	const db = getDb(event.platform!.env);
	const knownVideoIds = await findKnownVideoIds(db, videoIds);

	return json({ knownVideoIds });
};
