import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { claimAutoTagCandidates, getAllTagVectors } from '$lib/server/auto-tag/jobs';
import { verifyWebhookSignature } from '$lib/server/import/webhook-auth';
import { getVectorStore } from '$lib/server/embedding/vector-store';
import { recordAuditEvent } from '$lib/server/audit/log';

/**
 * Called by the auto-tag GitHub Actions workflow at the start of each run.
 * Returns everything CI needs to compute similarity in one round trip —
 * the videoIds needing tagging, their own audio embeddings (from
 * Vectorize), and every tag's precomputed text embedding — rather than
 * three separate calls, since all three are needed together and none is
 * large enough on its own to warrant splitting out.
 *
 * A videoId can come back from claimAutoTagCandidates with no entry in
 * songEmbeddings if its embedding job says 'done' but Vectorize's own
 * upsert hasn't landed yet (a narrow race, not the common case) — CI is
 * expected to just skip scoring anything missing from songEmbeddings
 * rather than treat that as an error, since the next run will pick it up
 * once Vectorize is consistent.
 */
export const POST: RequestHandler = async (event) => {
	const rawBody = await event.request.text();
	const signature = event.request.headers.get('X-Signature-256');
	const secret = event.platform!.env.EMBEDDING_WEBHOOK_SECRET;

	const isValid = await verifyWebhookSignature(rawBody, signature, secret);
	if (!isValid) {
		error(401, 'Invalid webhook signature');
	}

	const db = getDb(event.platform!.env.DB);
	const videoIds = await claimAutoTagCandidates(db);

	// tagVectors is fetched unconditionally, even with zero videoIds to
	// score — stage two's own CI script (rebuild_playlists.py) also hits
	// this same endpoint purely for the tag->facet mapping, and does so
	// on every run regardless of whether stage one found anything new to
	// tag. An early return here with a hardcoded empty tagVectors (as
	// this used to do) silently broke that reuse: a run with nothing new
	// to score returned no facets either, so stage two's playlists all
	// ended up tagged facet: "unknown" — confirmed live in production.
	if (videoIds.length === 0) {
		return json({ videoIds: [], songEmbeddings: {}, tagVectors: await getAllTagVectors(db) });
	}

	const vectorStore = getVectorStore(event.platform!.env);
	const [embeddingsByVideoId, tagVectorList] = await Promise.all([
		vectorStore.getSongEmbeddings(videoIds),
		getAllTagVectors(db)
	]);

	await recordAuditEvent(db, {
		eventType: 'auto_tag_claimed',
		targetType: 'song',
		detail: { videoIds, foundEmbeddingsCount: embeddingsByVideoId.size }
	});

	return json({
		videoIds,
		songEmbeddings: Object.fromEntries(embeddingsByVideoId),
		tagVectors: tagVectorList
	});
};
