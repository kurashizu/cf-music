import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { rebuildAutoTagPlaylists, countAutoTagPlaylists, type AutoTagPlaylistInput } from '$lib/server/auto-tag/jobs';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { recordAuditEvent } from '$lib/server/audit/log';

function isValidPlaylistInput(entry: unknown): entry is AutoTagPlaylistInput {
	if (typeof entry !== 'object' || entry === null) return false;
	const { tag, facet, videoIds } = entry as Record<string, unknown>;
	return (
		typeof tag === 'string' &&
		typeof facet === 'string' &&
		Array.isArray(videoIds) &&
		videoIds.every((v) => typeof v === 'string')
	);
}

/**
 * Called once per user by the auto-tag CI script's stage two, with the
 * whole set of tag groupings it computed for that user (>= 3 songs per
 * tag, z-score >= its own threshold — see the CI script itself for the
 * exact rule). Wholesale-replaces this user's auto_tag playlists rather
 * than diffing against the previous set — see rebuildAutoTagPlaylists'
 * own docstring for why that's fine for a system-generated playlist.
 */
export const POST: RequestHandler = async (event) => {
	const rawBody = await event.request.text();
	const signature = event.request.headers.get('X-Signature-256');
	const secret = event.platform!.env.EMBEDDING_WEBHOOK_SECRET;

	const isValid = await verifyWebhookSignature(rawBody, signature, secret);
	if (!isValid) {
		error(401, 'Invalid webhook signature');
	}

	const body: unknown = JSON.parse(rawBody);
	const playlistsInput = (body as { playlists?: unknown }).playlists;
	if (!Array.isArray(playlistsInput) || !playlistsInput.every(isValidPlaylistInput)) {
		error(400, 'playlists (array of { tag: string, facet: string, videoIds: string[] }) is required');
	}

	const db = getDb(event.platform!.env.DB);
	const userId = event.params.userId;
	await rebuildAutoTagPlaylists(db, userId, playlistsInput);
	const playlistCount = await countAutoTagPlaylists(db, userId);

	await recordAuditEvent(db, {
		userId,
		eventType: 'auto_tag_playlists_rebuilt',
		targetType: 'user',
		targetId: userId,
		detail: { playlistCount, tags: playlistsInput.map((p) => p.tag) }
	});

	return json({ playlistCount });
};
