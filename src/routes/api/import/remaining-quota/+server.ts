import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getUserQuotaBytes, getUserStorageUsageBytes } from '$lib/server/eviction/usage';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { pickStrings } from '$lib/server/http/validate';

/**
 * Called by the GitHub Actions import job after resolving the real size of
 * every not-yet-owned song in a batch (see import.py), so it can reject the
 * whole job up front rather than downloading partway into a batch that
 * won't fit. HMAC-signed like the other CI-facing endpoints — no user
 * session to authenticate with here, and the signed userId (not a session
 * cookie) is what scopes the quota lookup.
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
	const fields = pickStrings(body, ['userId']);
	if (!fields) {
		error(400, 'userId is required');
	}

	const db = getDb(event.platform!.env);
	const [quotaBytes, usageBytes] = await Promise.all([
		getUserQuotaBytes(db, fields.userId),
		getUserStorageUsageBytes(db, fields.userId)
	]);

	return json({ remainingBytes: Math.max(0, quotaBytes - usageBytes) });
};
