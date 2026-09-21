import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { getObjectStorage } from '$lib/server/storage/factory';
import { findDeadSongReferences, resolveDeadSongReference } from '$lib/server/eviction/orphan-scan';

/**
 * Reports `songs` rows whose audioKey/coverKey point at an S3 object that
 * no longer exists — see findDeadSongReferences.
 */
export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const db = getDb(event.platform!.env);
	const storage = getObjectStorage(event.platform!.env);

	return json(await findDeadSongReferences(db, storage));
};

/**
 * Resolves one dead reference the caller specifies — re-checked against a
 * fresh scan first (same reasoning as the orphans endpoint's DELETE: a real
 * re-import could have landed between the GET report and this call and
 * made the reference valid again).
 */
export const DELETE: RequestHandler = async (event) => {
	const session = requireAdmin(event);
	const body: unknown = await event.request.json().catch(() => null);
	const videoId =
		typeof body === 'object' && body !== null
			? (body as Record<string, unknown>).videoId
			: undefined;
	const field =
		typeof body === 'object' && body !== null ? (body as Record<string, unknown>).field : undefined;
	if (typeof videoId !== 'string' || (field !== 'audioKey' && field !== 'coverKey')) {
		error(400, 'videoId and field ("audioKey" or "coverKey") are required');
	}

	const db = getDb(event.platform!.env);
	const storage = getObjectStorage(event.platform!.env);

	const { deadReferences } = await findDeadSongReferences(db, storage);
	const stillDead = deadReferences.find((r) => r.videoId === videoId && r.field === field);
	if (!stillDead) {
		return json({ resolved: false, reason: 'No longer a dead reference' });
	}

	const { resolved } = await resolveDeadSongReference(db, session.userId, stillDead);
	return json({ resolved, reason: resolved ? undefined : 'Already resolved by another admin' });
};
