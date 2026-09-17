import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { claimEmbeddingJobs, failEmbeddingJob, getSongsForEmbeddingJobs } from '$lib/server/embedding/jobs';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { pickPositiveNumber } from '$lib/server/http/validate';
import { getObjectStorage } from '$lib/server/storage/factory';
import { recordAuditEvent } from '$lib/server/audit/log';

// One scheduled workflow run claims at most this many songs — keeps a
// single GitHub Actions job (60-minute timeout, same backstop as import.yml)
// comfortably within its time budget even if every song needs several
// audio-chunk embedding calls.
const MAX_CLAIM_LIMIT = 200;

/**
 * Called by the embedding GitHub Actions workflow at the start of each run
 * to pick up a batch of pending (or stale-processing, see claimEmbeddingJobs)
 * jobs. HMAC-signed like the import webhook routes — CI has no user session.
 * Returns a presigned GET URL per song rather than raw MinIO credentials, so
 * this workflow never needs the MinIO access/secret keys at all.
 */
export const POST: RequestHandler = async (event) => {
	const rawBody = await event.request.text();
	const signature = event.request.headers.get('X-Signature-256');
	const secret = event.platform!.env.EMBEDDING_WEBHOOK_SECRET;

	const isValid = await verifyWebhookSignature(rawBody, signature, secret);
	if (!isValid) {
		error(401, 'Invalid webhook signature');
	}

	const body: unknown = JSON.parse(rawBody);
	const limit = Math.min(pickPositiveNumber(body, 'limit') ?? MAX_CLAIM_LIMIT, MAX_CLAIM_LIMIT);

	const db = getDb(event.platform!.env.DB);
	const claimed = await claimEmbeddingJobs(db, limit);
	if (claimed.length === 0) {
		return json({ jobs: [] });
	}

	const songRows = await getSongsForEmbeddingJobs(db, claimed.map((c) => c.videoId));
	const songsByVideoId = new Map(songRows.map((s) => [s.videoId, s]));
	const storage = getObjectStorage(event.platform!.env);

	const jobs = await Promise.all(
		claimed.map(async (job) => {
			const song = songsByVideoId.get(job.videoId);
			if (!song) {
				// The song was deleted between enqueue and claim — this will
				// never resolve by retrying, so fail it outright rather than
				// leaving it stuck at 'processing' (nothing else would ever
				// revisit it, since it's silently absent from the response
				// CI acts on below).
				await failEmbeddingJob(db, {
					jobId: job.id,
					error: 'Song no longer exists',
					retryable: false
				});
				return null;
			}
			return {
				jobId: job.id,
				videoId: job.videoId,
				attempts: job.attempts,
				audioUrl: await storage.presignGetUrl(song.audioKey),
				durationSeconds: song.durationSeconds
			};
		})
	);

	const claimedJobs = jobs.filter((j) => j !== null);

	await recordAuditEvent(db, {
		eventType: 'embedding_claimed',
		targetType: 'embedding_job',
		detail: { videoIds: claimedJobs.map((j) => j.videoId), requestedLimit: limit }
	});

	return json({ jobs: claimedJobs });
};
