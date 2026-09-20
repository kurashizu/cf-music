const prefersReducedMotion =
	typeof window !== 'undefined' && typeof window.matchMedia === 'function'
		? window.matchMedia('(prefers-reduced-motion: reduce)')
		: null;

/** True if the user's OS/browser is set to reduce motion. Reactive callers should read this inside an effect if they need to react to it changing mid-session, but no page in this app needs that — it's read once per transition trigger. */
export function reducedMotion(): boolean {
	return prefersReducedMotion?.matches ?? false;
}

/**
 * Wraps a svelte/transition's params so it collapses to instant (duration 0)
 * under prefers-reduced-motion, without every call site needing its own
 * check. Usage: `transition:fade={motionParams({ duration: 150 })}`.
 */
export function motionParams<T extends { duration?: number }>(params: T): T {
	if (!reducedMotion()) return params;
	return { ...params, duration: 0 };
}

const coarsePointer =
	typeof window !== 'undefined' && typeof window.matchMedia === 'function'
		? window.matchMedia('(hover: none), (pointer: coarse)')
		: null;

/**
 * True on touch-primary devices (phones, tablets).
 *
 * Tooltips are hover affordances; with no hover, tapping a trigger opens one
 * that then sits there until something else is tapped. Every tooltip in this
 * app labels a control that already carries the same text in its aria-label,
 * so suppressing them on touch loses nothing.
 */
export function isTouchDevice(): boolean {
	return coarsePointer?.matches ?? false;
}
