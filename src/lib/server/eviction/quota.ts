import {
	planEviction,
	type EvictionCandidate,
	type EvictionPlan
} from '../../shared/eviction-score';

export type QuotaCheckResult =
	| { outcome: 'fits'; bytesAvailable: number }
	| { outcome: 'exceeds_total_quota'; quotaBytes: number; fileSizeBytes: number }
	| { outcome: 'needs_eviction'; plan: EvictionPlan };

export interface QuotaCheckInput {
	fileSizeBytes: number;
	quotaBytes: number;
	usedBytes: number;
	existingSongs: EvictionCandidate[];
	now?: Date;
	halfLifeDays?: number;
}

/**
 * Decides whether a new file can be imported given the user's quota:
 * - fits outright -> `fits`
 * - larger than the user's total quota -> `exceeds_total_quota` (no eviction can help)
 * - fits within quota but not within remaining free space -> `needs_eviction` with a plan
 */
export function checkQuota({
	fileSizeBytes,
	quotaBytes,
	usedBytes,
	existingSongs,
	now,
	halfLifeDays
}: QuotaCheckInput): QuotaCheckResult {
	if (fileSizeBytes > quotaBytes) {
		return { outcome: 'exceeds_total_quota', quotaBytes, fileSizeBytes };
	}

	const bytesAvailable = quotaBytes - usedBytes;
	if (fileSizeBytes <= bytesAvailable) {
		return { outcome: 'fits', bytesAvailable };
	}

	const bytesNeeded = fileSizeBytes - bytesAvailable;
	const plan = planEviction(existingSongs, bytesNeeded, { now, halfLifeDays });
	return { outcome: 'needs_eviction', plan };
}
