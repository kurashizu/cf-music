import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { pickStrings } from '$lib/server/http/validate';
import { createImportJob, listImportJobs, failImportJob } from '$lib/server/import/jobs';
import { dispatchImportWorkflow } from '$lib/server/import/github-actions';
import { ensureDefaultPlaylist } from '$lib/server/library/playlists';

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
	// An empty string means "no playlist selected" client-side (see the
	// import page's Select binding) — treat it the same as omitted rather
	// than storing it, which would otherwise violate target_playlist_id's
	// foreign key the moment it's dereferenced as a real playlist id.
	const explicitTargetPlaylistId =
		typeof targetPlaylistIdRaw === 'string' && targetPlaylistIdRaw.length > 0 ? targetPlaylistIdRaw : undefined;

	const env = event.platform!.env;
	const db = getDb(env.DB);

	// Every song has to end up reachable through some playlist — there's
	// no "just import it, don't file it anywhere" option — so an import
	// with no explicit target falls back to the user's default playlist
	// (created on first use) rather than leaving the song's only trace in
	// the global songs table.
	const targetPlaylistId =
		explicitTargetPlaylistId ?? (await ensureDefaultPlaylist(db, session.userId)).id;

	const { id: jobId } = await createImportJob(db, {
		userId: session.userId,
		sourceUrl: fields.sourceUrl,
		targetPlaylistId
	});

	try {
		await dispatchImportWorkflow(
			{
				owner: env.GITHUB_REPO_OWNER,
				repo: env.GITHUB_REPO_NAME,
				workflowFileName: env.GITHUB_IMPORT_WORKFLOW_FILE,
				token: env.GITHUB_ACTIONS_TOKEN
			},
			{ jobId, userId: session.userId, sourceUrl: fields.sourceUrl }
		);
	} catch (err) {
		// The D1 row above already committed — if GitHub never actually
		// receives the dispatch (rate limited, bad token, network error),
		// no CI process is ever going to connect and move this job past
		// `pending`. Marking it failed immediately here means the user
		// sees a normal failure instead of a job that just sits there
		// until they notice and cancel it themselves.
		await failImportJob(db, jobId, session.userId, 'Failed to start the import workflow');
		throw err;
	}

	return json({ jobId }, { status: 201 });
};
