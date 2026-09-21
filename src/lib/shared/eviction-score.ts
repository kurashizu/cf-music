/**
 * Eviction score: LFU weighted by exponential recency decay.
 *
 * Shared rather than server-only because the browser runs exactly the same
 * ranking to decide which auto-cached songs to drop when the local cache
 * hits its limit (see src/lib/client/cache-limit.ts). One algorithm, so
 * "what gets dropped first" means the same thing in both places instead of
 * two policies drifting apart. Pure arithmetic — no imports, no platform
 * assumptions.
 *
 * score = playCount * 0.5^(daysSinceLastPlayed / halfLifeDays)
 *
 * Never-played songs (playCount === 0) always score 0, so they sort
 * below anything that has ever been played, tie-broken by import
 * recency (oldest imports evicted first) by the caller.
 */

export const DEFAULT_HALF_LIFE_DAYS = 30;

export interface EvictionScoreInput {
	playCount: number;
	lastPlayedAt: Date | null;
	now?: Date;
	halfLifeDays?: number;
}

export function computeEvictionScore({
	playCount,
	lastPlayedAt,
	now = new Date(),
	halfLifeDays = DEFAULT_HALF_LIFE_DAYS
}: EvictionScoreInput): number {
	// The `<= 0` (vs `< 0`) distinction is unobservable at playCount === 0:
	// falling through would compute `0 * decay`, which is 0 regardless of
	// decay, matching this guard's early return exactly. Only strictly
	// negative playCount values need the guard to avoid decay math running
	// on nonsensical input (defensive; playCount should never be negative
	// in practice).
	// Stryker disable next-line EqualityOperator
	if (playCount <= 0 || lastPlayedAt === null) return 0;

	const daysSincePlayed = Math.max(0, (now.getTime() - lastPlayedAt.getTime()) / 86_400_000);
	const decay = Math.pow(0.5, daysSincePlayed / halfLifeDays);
	return playCount * decay;
}

export interface EvictionCandidate {
	videoId: string;
	playCount: number;
	lastPlayedAt: Date | null;
	importedAt: Date;
	fileSizeBytes: number;
}

export interface RankedCandidate extends EvictionCandidate {
	score: number;
}

/**
 * Sorts candidates from most-evictable to least-evictable:
 * lowest score first; ties among score-0 (never played) candidates
 * broken by oldest import first.
 */
export function rankEvictionCandidates(
	candidates: EvictionCandidate[],
	options: { now?: Date; halfLifeDays?: number } = {}
): RankedCandidate[] {
	const ranked = candidates.map((c) => ({
		...c,
		score: computeEvictionScore({
			playCount: c.playCount,
			lastPlayedAt: c.lastPlayedAt,
			now: options.now,
			halfLifeDays: options.halfLifeDays
		})
	}));

	return ranked.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		// tie-break: older import evicted first
		return a.importedAt.getTime() - b.importedAt.getTime();
	});
}

export interface EvictionPlan {
	toEvict: RankedCandidate[];
	bytesFreed: number;
	sufficient: boolean;
}

/**
 * Greedily selects the most-evictable candidates until `bytesNeeded`
 * is freed, or candidates are exhausted (`sufficient: false`).
 */
export function planEviction(
	candidates: EvictionCandidate[],
	bytesNeeded: number,
	options: { now?: Date; halfLifeDays?: number } = {}
): EvictionPlan {
	// Purely an optimization to skip sorting when nothing needs to be freed:
	// the loop's own `bytesFreed >= bytesNeeded` break condition already
	// produces the identical `{ toEvict: [], bytesFreed: 0, sufficient: true }`
	// result for any bytesNeeded <= 0, so this guard is behaviorally
	// redundant (an equivalent mutant if removed/altered) — see planEviction
	// tests for bytesNeeded <= 0.
	// Stryker disable next-line ConditionalExpression,EqualityOperator
	if (bytesNeeded <= 0) return { toEvict: [], bytesFreed: 0, sufficient: true };

	const ranked = rankEvictionCandidates(candidates, options);
	const toEvict: RankedCandidate[] = [];
	let bytesFreed = 0;

	for (const candidate of ranked) {
		if (bytesFreed >= bytesNeeded) break;
		toEvict.push(candidate);
		bytesFreed += candidate.fileSizeBytes;
	}

	return { toEvict, bytesFreed, sufficient: bytesFreed >= bytesNeeded };
}
