import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { enqueueMissingEmbeddingJobs } from '$lib/server/embedding/jobs';

/**
 * One-time (but safely repeatable — see enqueueMissingEmbeddingJobs) backfill
 * for songs imported before the embedding pipeline existed. Manually
 * triggered by an admin rather than run automatically on deploy, since it's
 * a no-op after the first successful run and there's no reason to check on
 * every deploy indefinitely.
 */
export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	const db = getDb(event.platform!.env);
	const queuedCount = await enqueueMissingEmbeddingJobs(db);
	return json({ queuedCount });
};
