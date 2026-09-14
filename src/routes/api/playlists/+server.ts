import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireSession } from '$lib/server/auth/guard';
import { createPlaylist, listPlaylists } from '$lib/server/library/playlists';
import { pickStrings } from '$lib/server/http/validate';

export const GET: RequestHandler = async (event) => {
	const session = requireSession(event);
	const db = getDb(event.platform!.env.DB);

	return json(await listPlaylists(db, session.userId));
};

export const POST: RequestHandler = async (event) => {
	const session = requireSession(event);
	const body = await event.request.json().catch(() => null);
	const fields = pickStrings(body, ['name'] as const);
	if (!fields || fields.name.trim().length === 0) {
		error(400, 'name is required');
	}

	const db = getDb(event.platform!.env.DB);
	const result = await createPlaylist(db, { userId: session.userId, name: fields.name });

	return json(result, { status: 201 });
};
