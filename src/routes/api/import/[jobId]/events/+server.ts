import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import {
	getImportJobUnchecked,
	startImportJob,
	recordSongImported,
	recordSongFailed,
	completeImportJob,
	ImportJobError
} from '$lib/server/import/jobs';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { reportImportProgress } from '$lib/server/durable-objects/client';
import { isImportEventBody } from '$lib/server/import/event-body';

/**
 * Receives one progress event per call from the GitHub Actions import
 * workflow. Authenticated via HMAC signature (shared secret), not a user
 * session — CI has no browser session to present. After updating D1 (the
 * source of truth), forwards the job's current tallies to the owning
 * user's Durable Object for real-time WebSocket broadcast; the frontend
 * can also poll GET /api/import/[jobId] if the socket ever drops.
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
	if (!isImportEventBody(body)) {
		error(400, 'Invalid event body');
	}

	const db = getDb(event.platform!.env.DB);
	const jobId = event.params.jobId;

	let job;
	try {
		job = await getImportJobUnchecked(db, jobId);
	} catch (err) {
		if (err instanceof ImportJobError) error(404, err.message);
		throw err;
	}

	switch (body.type) {
		case 'start':
			if (typeof body.totalCount !== 'number') error(400, 'totalCount is required for a start event');
			await startImportJob(db, jobId, body.totalCount);
			break;
		case 'song_success':
			if (!body.song) error(400, 'song is required for a song_success event');
			await recordSongImported(db, jobId, job.userId, body.song);
			break;
		case 'song_failed':
			if (!body.failure) error(400, 'failure is required for a song_failed event');
			await recordSongFailed(db, jobId, job.userId, body.failure);
			break;
		case 'complete':
			await completeImportJob(db, jobId, job.userId);
			break;
	}

	const updated = await getImportJobUnchecked(db, jobId);
	await reportImportProgress(event.platform!.env, job.userId, {
		jobId,
		status: updated.status,
		totalCount: updated.totalCount,
		completedCount: updated.completedCount,
		failedCount: updated.failedCount
	});

	return json({ ok: true });
};
