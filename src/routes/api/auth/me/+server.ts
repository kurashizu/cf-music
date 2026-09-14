import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session) {
		error(401, 'Not authenticated');
	}

	return json(locals.session);
};
