import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { getObjectStorage } from '$lib/server/storage/factory';
import { findDeadSongReferences } from '$lib/server/eviction/orphan-scan';

/**
 * Reports `songs` rows whose audioKey/coverKey point at an S3 object that
 * no longer exists — see findDeadSongReferences. Report-only: unlike
 * orphaned objects (safe to just delete), a dead reference needs a human
 * to decide whether to re-import the song or delete the row, so there's no
 * corresponding DELETE here.
 */
export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const db = getDb(event.platform!.env.DB);
	const storage = getObjectStorage(event.platform!.env);

	return json(await findDeadSongReferences(db, storage));
};
