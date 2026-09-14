/**
 * "Real play" threshold, mirroring Spotify-style logic: whichever
 * comes first between 30 seconds and 50% of the track's duration.
 * Short clips (e.g. a 40s track) don't unfairly require the full 30s.
 */
export const MAX_THRESHOLD_SECONDS = 30;
export const DURATION_FRACTION = 0.5;

export function computePlayThresholdSeconds(durationSeconds: number): number {
	// The `<= 0` (vs `< 0`) distinction is unobservable at durationSeconds === 0:
	// Math.min(30, 0 * 0.5) already evaluates to 0 via the formula below, so the
	// guard is only behaviorally necessary for strictly negative durations (which
	// would otherwise produce a negative, nonsensical threshold).
	// Stryker disable next-line EqualityOperator
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
	return Math.min(MAX_THRESHOLD_SECONDS, durationSeconds * DURATION_FRACTION);
}

export function hasReachedPlayThreshold(
	currentTimeSeconds: number,
	durationSeconds: number
): boolean {
	return currentTimeSeconds >= computePlayThresholdSeconds(durationSeconds);
}
