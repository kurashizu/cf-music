import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listPlaylists } from '$lib/server/library/playlists';
import { listImportJobs } from '$lib/server/import/jobs';
import { runImportSweep } from '$lib/server/scheduled/import-sweep';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.session) {
		redirect(303, '/');
	}

	const db = getDb(platform!.env.DB);
	const [playlists, importJobs] = await Promise.all([
		listPlaylists(db, locals.session.userId),
		listImportJobs(db, locals.session.userId)
	]);

	// No account-level Cron Trigger available (Workers Free caps those at 5
	// account-wide) to run the stale-job sweep on a schedule — piggybacking
	// on this page's own load covers the case that actually matters: a user
	// looking at a job that appears stuck. waitUntil lets it run after the
	// response is already on its way, so a slow scan never delays the page.
	platform!.ctx.waitUntil(runImportSweep(platform!.env));

	return { playlists, importJobs };
};
