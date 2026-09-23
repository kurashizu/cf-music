import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import {
	generateSmartPlaylistsForUsers,
	USERS_PER_GENERATE_REQUEST
} from '$lib/server/library/smart-playlists';

/**
 * Called by the scheduled smart-playlists GitHub Actions workflow — wipes
 * and regenerates every user's Artists/play-history playlists. HMAC-signed
 * like the import/embedding webhook routes, reusing EMBEDDING_WEBHOOK_SECRET
 * rather than provisioning a whole separate secret for one more CI job that
 * doesn't need independent rotation.
 *
 * One page of users per call, resumed from `after`: each user costs a few
 * round trips to the database, and a Worker may only make so many per
 * request, so covering every user in one call would stop working at some
 * number of users. The response's `nextAfter` is null once there are none
 * left, which is what the workflow loops on.
 */
export const POST: RequestHandler = async (event) => {
	const rawBody = await event.request.text();
	const signature = event.request.headers.get('X-Signature-256');
	const secret = event.platform!.env.EMBEDDING_WEBHOOK_SECRET;

	const isValid = await verifyWebhookSignature(rawBody, signature, secret);
	if (!isValid) {
		error(401, 'Invalid webhook signature');
	}

	let after: string | undefined;
	try {
		const body = JSON.parse(rawBody || '{}') as { after?: unknown };
		if (body.after !== undefined && typeof body.after !== 'string') throw new Error();
		after = body.after;
	} catch {
		error(400, 'Body must be JSON with an optional string `after`');
	}

	const db = getDb(event.platform!.env);
	const result = await generateSmartPlaylistsForUsers(db, {
		after,
		limit: USERS_PER_GENERATE_REQUEST
	});

	return json(result);
};
