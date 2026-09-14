import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { getImportJob, ImportJobError } from '$lib/server/import/jobs';

/** Polling fallback for import progress, in case the WebSocket connection dropped. */
export const GET: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env.DB);

	try {
		return json(await getImportJob(db, event.params.jobId, session.userId));
	} catch (err) {
		if (err instanceof ImportJobError) error(404, err.message);
		throw err;
	}
};
