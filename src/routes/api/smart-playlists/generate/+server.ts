import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { generateSmartPlaylistsForAllUsers } from '$lib/server/library/smart-playlists';

/**
 * Called by the scheduled smart-playlists GitHub Actions workflow — wipes
 * and regenerates every user's Artists/play-history playlists. HMAC-signed
 * like the import/embedding webhook routes, reusing EMBEDDING_WEBHOOK_SECRET
 * rather than provisioning a whole separate secret for one more CI job that
 * doesn't need independent rotation.
 */
export const POST: RequestHandler = async (event) => {
	const rawBody = await event.request.text();
	const signature = event.request.headers.get('X-Signature-256');
	const secret = event.platform!.env.EMBEDDING_WEBHOOK_SECRET;

	const isValid = await verifyWebhookSignature(rawBody, signature, secret);
	if (!isValid) {
		error(401, 'Invalid webhook signature');
	}

	const db = getDb(event.platform!.env);
	const result = await generateSmartPlaylistsForAllUsers(db);

	return json(result);
};
