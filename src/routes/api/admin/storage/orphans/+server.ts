import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { getObjectStorage } from '$lib/server/storage/factory';
import { findOrphanedObjects } from '$lib/server/eviction/orphan-scan';

/** Reports S3 objects with no corresponding `songs` row — see findOrphanedObjects. Report-only, deletes nothing. */
export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const db = getDb(event.platform!.env.DB);
	const storage = getObjectStorage(event.platform!.env);

	return json(await findOrphanedObjects(db, storage));
};

/**
 * Deletes exactly the keys the caller lists, after re-checking each one is
 * still orphaned right before deleting it — re-checked rather than trusting
 * the list as-is because a real import/upload can land between the GET
 * report and this call, and a key that was orphaned a minute ago might not
 * be anymore.
 */
export const DELETE: RequestHandler = async (event) => {
	requireAdmin(event);
	const body: unknown = await event.request.json().catch(() => null);
	const keys =
		typeof body === 'object' && body !== null ? (body as Record<string, unknown>).keys : undefined;
	if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
		error(400, 'keys must be a string array');
	}

	const db = getDb(event.platform!.env.DB);
	const storage = getObjectStorage(event.platform!.env);

	const { orphanKeys } = await findOrphanedObjects(db, storage);
	const stillOrphaned = new Set(orphanKeys);
	const toDelete = (keys as string[]).filter((k) => stillOrphaned.has(k));

	await storage.deleteObjects(toDelete);

	return json({
		deletedKeys: toDelete,
		skippedKeys: (keys as string[]).filter((k) => !stillOrphaned.has(k))
	});
};
