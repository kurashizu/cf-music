import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { previewEvictionForImport } from '$lib/server/eviction/execute';
import { pickPositiveNumber } from '$lib/server/http/validate';

/**
 * Previews what an import of `fileSizeBytes` would require: fits outright,
 * exceeds the user's total quota outright, or needs evicting the returned
 * set of songs. Per the design, eviction (auto or manual) always requires
 * this upfront confirmation before anything is actually deleted.
 */
export const POST: RequestHandler = async (event) => {
	const session = requireSession(event);
	const body = await event.request.json().catch(() => null);

	const fileSizeBytes = pickPositiveNumber(body, 'fileSizeBytes');
	if (fileSizeBytes === null) {
		error(400, 'fileSizeBytes must be a positive number');
	}

	const db = getDb(event.platform!.env);
	const result = await previewEvictionForImport(db, session.userId, fileSizeBytes);

	return json(result);
};
