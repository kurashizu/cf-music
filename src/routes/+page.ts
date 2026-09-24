import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// This route is the login/register screen. Reaching it signed in means the
// visitor just opened the bare domain, so send them where they were going
// instead of presenting a login form they don't need to fill in. The page is
// the static app shell (see +layout.ts), so the check is the browser's.
export const load: PageLoad = async ({ fetch }) => {
	const res = await fetch('/api/auth/me');
	if (res.ok) {
		redirect(303, '/library');
	}
	return {};
};
