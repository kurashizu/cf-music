export type RepeatMode = 'off' | 'all' | 'one';

/** Fisher-Yates shuffle of `[0, length)`, used to build a randomized play order. */
export function shuffleOrder(length: number, random: () => number = Math.random): number[] {
	const order = Array.from({ length }, (_, i) => i);
	// `i > 0` vs `i >= 0`: on the would-be extra final iteration (i === 0), j is
	// always floor(random() * 1) = 0 regardless of random()'s output, so the
	// "swap" is order[0] with itself — a no-op no random() value can make
	// observable. Equivalent mutant, not a coverage gap.
	// Stryker disable next-line EqualityOperator
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
	}
	return order;
}

/**
 * Whether advancing the queue by `direction` stays in bounds, wrapping to the
 * start only when moving forward off the end with repeat-all enabled. Moving
 * backward never wraps — going "previous" from the first track just stays put
 * (the player restarts the current track instead; see hasPrevious).
 */
export function nextQueueIndex(
	currentIndex: number,
	queueLength: number,
	direction: 1 | -1,
	repeatMode: RepeatMode
): number | null {
	const candidate = currentIndex + direction;
	if (candidate >= 0 && candidate < queueLength) return candidate;
	if (direction === 1 && repeatMode === 'all' && queueLength > 0) return 0;
	return null;
}

export function cycleRepeatMode(current: RepeatMode): RepeatMode {
	if (current === 'off') return 'all';
	if (current === 'all') return 'one';
	return 'off';
}

/**
 * Reorders `shuffleIndices` so the track currently playing (identified by
 * its real queue position) becomes the new first entry, without duplicating
 * or dropping any index — used when shuffle is toggled on mid-playback so
 * the current track keeps playing instead of jumping to a random one.
 */
export function moveIndexToFront(indices: number[], target: number): number[] {
	return [target, ...indices.filter((i) => i !== target)];
}
