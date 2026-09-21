import { getDb } from '../db';
import { failStaleImportJobs } from '../import/jobs';

// Anything still reporting no progress after this long has either never
// started (workflow_dispatch queued but never ran) or died silently before
// ever opening its WebSocket to the Durable Object, which is the one
// zombie-job case webSocketClose/webSocketError can't see (see
// findStaleImportJobs).
//
// Comfortably past the import's own three-hour limit (JOB_TIMEOUT_SECONDS
// in docker/import/import.py), because a throttled job is legitimately
// silent for long stretches: it can sit out a 30-minute backoff without
// finishing a single song, and failing it here would discard a run that
// was only waiting. The job reports its own timeout, so this sweep is for
// jobs that never got far enough to report anything.
const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

export async function runImportSweep(env: Env): Promise<void> {
	const db = getDb(env.DB);
	await failStaleImportJobs(db, STALE_AFTER_MS);
}
