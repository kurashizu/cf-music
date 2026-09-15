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
