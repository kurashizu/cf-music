import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listAllUserIds } from '$lib/server/auto-tag/jobs';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';

/**
 * Called by the auto-tag CI script's stage two — the whole list of user
 * ids it then loops over one at a time, rebuilding each user's own
 * auto_tag playlists before moving to the next. No body/params needed
 * (still POST, not GET, so the empty body can still be HMAC-signed the
 * same way every other CI callback is).
 */
export const POST: RequestHandler = async (event) => {
	const rawBody = await event.request.text();
	const signature = event.request.headers.get('X-Signature-256');
	const secret = event.platform!.env.EMBEDDING_WEBHOOK_SECRET;

	const isValid = await verifyWebhookSignature(rawBody, signature, secret);
	if (!isValid) {
		error(401, 'Invalid webhook signature');
	}

	const db = getDb(event.platform!.env.DB);
	const userIds = await listAllUserIds(db);

	return json({ userIds });
};
