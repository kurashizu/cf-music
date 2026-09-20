import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// This route is the login/register screen. Reaching it with a session
// already resolved (see hooks.server.ts) means the visitor is signed in and
// just opened the bare domain, so send them where they were going instead
// of presenting a login form they don't need to fill in.
export const load: PageServerLoad = async ({ locals }) => {
	if (locals.session) {
		redirect(303, '/library');
	}
	return {};
};
