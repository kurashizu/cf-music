/**
 * The message a failed API response carries, or a fallback.
 *
 * Every route here reports failures through SvelteKit's `error(status, msg)`,
 * which puts a specific, user-meaningful sentence in the body — "Cannot
 * remove songs from your default playlist", say. Most call sites threw that
 * away and toasted something generic instead, so a reader hitting a rule the
 * server enforces was told only "Failed to remove song" and had no way to
 * learn why.
 *
 * The fallback keeps the previous wording for anything the server didn't
 * explain: a 500 with an empty body, a response that isn't JSON at all, or
 * SvelteKit's own placeholder for an unhandled throw — which says less than
 * the caller's own sentence does about what the reader was trying to do.
 */
const UNINFORMATIVE = new Set(['internal error', 'internal server error', 'error', 'bad request']);

export async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
	const body = (await response.json().catch(() => null)) as { message?: string } | null;
	const message = body?.message?.trim();
	if (!message || UNINFORMATIVE.has(message.toLowerCase())) return fallback;
	return message;
}
