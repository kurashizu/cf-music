import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getImportJobUnchecked, ImportJobError } from '$lib/server/import/jobs';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';

/**
 * WebSocket upgrade endpoint for import progress. Two kinds of caller:
 *
 * - A logged-in browser tab, watching one user's imports. Authenticated the
 *   normal way, via the session cookie (already resolved into
 *   event.locals.session by hooks.server.ts).
 * - The GitHub Actions import job for one specific job id, connecting out
 *   to report progress and receive confirm/cancel decisions — it has no
 *   session, so it's authenticated the same HMAC way as the /events and
 *   /known-video-ids callbacks, with jobId itself as the signed payload
 *   (there's no request body on a GET upgrade to sign instead) and the
 *   signature passed as a query param since this is a plain WebSocket
 *   upgrade, not a fetch() call with custom headers.
 */
export const GET: RequestHandler = async (event) => {
	if (event.request.headers.get('Upgrade') !== 'websocket') {
		error(426, 'Expected a WebSocket upgrade');
	}

	const role = event.url.searchParams.get('role');
	const db = getDb(event.platform!.env.DB);

	let userId: string;
	let doRequestUrl: string;

	if (role === 'ci') {
		const jobId = event.url.searchParams.get('jobId');
		const signature = event.url.searchParams.get('signature');
		if (!jobId || !signature) {
			error(400, 'jobId and signature are required');
		}

		const isValid = await verifyWebhookSignature(
			jobId,
			`sha256=${signature}`,
			event.platform!.env.IMPORT_WEBHOOK_SECRET
		);
		if (!isValid) {
			error(401, 'Invalid signature');
		}

		try {
			const job = await getImportJobUnchecked(db, jobId);
			userId = job.userId;
		} catch (err) {
			if (err instanceof ImportJobError) error(404, err.message);
			throw err;
		}

		doRequestUrl = `https://do/ws?role=ci&jobId=${encodeURIComponent(jobId)}`;
	} else {
		if (!event.locals.session) {
			error(401, 'Authentication required');
		}
		userId = event.locals.session.userId;
		doRequestUrl = 'https://do/ws';
	}

	const id = event.platform!.env.IMPORT_PROGRESS.idFromName(userId);
	const stub = event.platform!.env.IMPORT_PROGRESS.get(id);

	return stub.fetch(doRequestUrl, event.request);
};
