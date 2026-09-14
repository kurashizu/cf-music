import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { pickStrings } from '$lib/server/http/validate';
import { createImportJob, listImportJobs } from '$lib/server/import/jobs';
import { dispatchImportWorkflow } from '$lib/server/import/github-actions';

/** Lists the caller's own recent import jobs, most recent first — see listImportJobs for why. */
export const GET: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env.DB);

	return json(await listImportJobs(db, session.userId));
};

/**
 * Starts an import: creates the D1 job record, then dispatches the GitHub
 * Actions workflow that actually runs yt-dlp. Progress (preview, per-song
 * results, completion) is reported back asynchronously over the CI job's
 * own WebSocket connection to /api/import/ws — see
 * src/lib/server/durable-objects/import-progress.ts — not this endpoint's
 * response.
 */
export const POST: RequestHandler = async (event) => {
	const session = requireSession(event);
	const body = await event.request.json().catch(() => null);
	const fields = pickStrings(body, ['sourceUrl'] as const);
	if (!fields || fields.sourceUrl.trim().length === 0) {
		error(400, 'sourceUrl is required');
	}

	const targetPlaylistIdRaw =
		typeof body === 'object' && body !== null ? (body as Record<string, unknown>).targetPlaylistId : undefined;
	const targetPlaylistId = typeof targetPlaylistIdRaw === 'string' ? targetPlaylistIdRaw : undefined;

	const env = event.platform!.env;
	const db = getDb(env.DB);

	const { id: jobId } = await createImportJob(db, {
		userId: session.userId,
		sourceUrl: fields.sourceUrl,
		targetPlaylistId
	});

	await dispatchImportWorkflow(
		{
			owner: env.GITHUB_REPO_OWNER,
			repo: env.GITHUB_REPO_NAME,
			workflowFileName: env.GITHUB_IMPORT_WORKFLOW_FILE,
			token: env.GITHUB_ACTIONS_TOKEN
		},
		{ jobId, userId: session.userId, sourceUrl: fields.sourceUrl }
	);

	return json({ jobId }, { status: 201 });
};
