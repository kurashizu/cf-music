import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listPlaylists } from '$lib/server/library/playlists';
import { listImportJobs } from '$lib/server/import/jobs';
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

	return { playlists, importJobs };
};
