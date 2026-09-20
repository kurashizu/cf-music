import { json } from '@sveltejs/kit';
import { requireSession } from '$lib/server/auth/guard';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	return json(requireSession(event));
};
