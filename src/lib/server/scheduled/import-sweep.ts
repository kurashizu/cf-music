import { getDb } from '../db';
import { failStaleImportJobs } from '../import/jobs';

// GitHub Actions runners for this workflow finish well under an hour even
// for a large playlist (see docker/import/import.py's per-song timeout) —
// anything still reporting no progress after this long has either never
// started (workflow_dispatch queued but never ran) or died silently before
// ever opening its WebSocket to the Durable Object, which is the one
// zombie-job case webSocketClose/webSocketError can't see (see
// findStaleImportJobs).
const STALE_AFTER_MS = 60 * 60 * 1000;

export async function runImportSweep(env: Env): Promise<void> {
	const db = getDb(env.DB);
	await failStaleImportJobs(db, STALE_AFTER_MS);
}
