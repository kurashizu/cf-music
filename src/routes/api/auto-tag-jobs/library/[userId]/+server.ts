import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getUserLibraryAutoTags } from '$lib/server/auto-tag/jobs';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';

/**
 * Called by the auto-tag CI script's stage two, once per user id from
 * /api/auto-tag-jobs/users — every song reachable through that user's
 * own custom playlists, with each song's precomputed autoTags (stage
 * one's output). CI computes the z-score threshold and tag grouping
 * itself from this; the Worker only ever writes what CI decided (see
 * the playlists/[userId] endpoint), never the classification logic.
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
	const songsWithAutoTags = await getUserLibraryAutoTags(db, event.params.userId);

	return json({ songs: songsWithAutoTags });
};
