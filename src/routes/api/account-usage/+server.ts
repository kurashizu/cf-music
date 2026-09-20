import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { getUserQuotaBytes, getUserStorageUsageBytes } from '$lib/server/eviction/usage';
import type { RequestHandler } from './$types';

/**
 * The account's cloud storage figures and who is signed in.
 *
 * Fetched by the settings page rather than loaded server-side, so that page
 * renders with no connection: most of what it offers is device-local — skip
 * silence, clearing local data, what this browser has cached — and none of
 * that should be unreachable because one storage total needs the server.
 */
export const GET: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env.DB);
	const [quotaBytes, usageBytes] = await Promise.all([
		getUserQuotaBytes(db, session.userId),
		getUserStorageUsageBytes(db, session.userId)
	]);
	return json({
		quotaBytes,
		usageBytes,
		session: { username: session.username, isAdmin: session.isAdmin }
	});
};
