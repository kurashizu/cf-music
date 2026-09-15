/**
 * Slices a single `Range: bytes=start-end` (the only form browsers ever
 * send for <audio> playback/seeking — no multipart ranges) out of a full,
 * already-cached Response's body, producing a real 206 the browser can't
 * tell apart from one the network would have given it. Returns null for
 * anything unparseable/unsatisfiable, so the caller can fall back to a
 * real fetch rather than serve something wrong.
 *
 * Kept out of service-worker.ts (which can't be imported outside a real
 * ServiceWorkerGlobalScope — see service-worker-register.test.ts's own
 * comment on why service-worker.ts itself has no unit tests) so this pure
 * slicing logic can be exercised directly instead.
 */
export async function sliceRangeFromCachedResponse(
	cached: Response,
	rangeHeader: string
): Promise<Response | null> {
	const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
	if (!match) return null;

	const buffer = await cached.arrayBuffer();
	const totalLength = buffer.byteLength;
	const [startStr, endStr] = [match[1], match[2]];

	// bytes=-500 (suffix form, "last 500 bytes") vs the usual bytes=500-
	// (from byte 500 to the end) vs bytes=500-999 (an explicit end) — all
	// three are legal and <audio> elements use the first two in practice.
	let start: number;
	let end: number;
	if (startStr === '') {
		if (endStr === '') return null;
		const suffixLength = Number(endStr);
		start = Math.max(0, totalLength - suffixLength);
		end = totalLength - 1;
	} else {
		start = Number(startStr);
		end = endStr === '' ? totalLength - 1 : Math.min(Number(endStr), totalLength - 1);
	}
	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalLength) {
		return null;
	}

	const slice = buffer.slice(start, end + 1);
	const headers = new Headers(cached.headers);
	headers.set('Content-Range', `bytes ${start}-${end}/${totalLength}`);
	headers.set('Content-Length', String(slice.byteLength));
	return new Response(slice, { status: 206, statusText: 'Partial Content', headers });
}
