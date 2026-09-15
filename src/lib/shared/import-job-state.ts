import type {
	ImportProgressEvent,
	ImportJobStatus,
	PreviewEntry,
	SongImportFailureInput
} from './import-events';

export interface ImportJobState {
	jobId: string;
	sourceUrl: string;
	status: ImportJobStatus;
	totalCount: number | null;
	completedCount: number;
	failedCount: number;
	failures: SongImportFailureInput[];
	previewEntries: PreviewEntry[] | null;
	// Distinct from `failures` (per-song failures in an otherwise-proceeding
	// batch): set when the whole job failed before/outside the per-song
	// loop — source extraction, WARP setup, etc. — so there's no video to
	// attribute a per-song failure to.
	fatalError: string | null;
	// Progress through the pre-download size-probing phase (before `preview`
	// fires) — null once probing hasn't started or has already finished
	// (superseded by totalCount/completedCount+failedCount at that point).
	probing: { checked: number; total: number } | null;
}

function applyStart(job: ImportJobState, totalCount: number): ImportJobState {
	return { ...job, status: 'running', totalCount };
}

function applyProbingProgress(job: ImportJobState, checked: number, total: number): ImportJobState {
	return { ...job, probing: { checked, total } };
}

function applyPreview(job: ImportJobState, entries: PreviewEntry[]): ImportJobState {
	return { ...job, previewEntries: entries, probing: null };
}

function applySongSuccess(job: ImportJobState): ImportJobState {
	return { ...job, completedCount: job.completedCount + 1 };
}

function applySongFailed(job: ImportJobState, failure: SongImportFailureInput): ImportJobState {
	return { ...job, failedCount: job.failedCount + 1, failures: [...job.failures, failure] };
}

/** Mirrors completeImportJob()'s server-side rule exactly: failed only when every song failed and none succeeded, otherwise completed. */
function applyComplete(job: ImportJobState): ImportJobState {
	const failed = job.failedCount > 0 && job.completedCount === 0;
	return { ...job, status: failed ? 'failed' : 'completed' };
}

/** Mirrors failImportJob()'s server-side transition: an error outside the per-song loop marks the whole job failed outright. */
function applyFatalError(job: ImportJobState, reason: string): ImportJobState {
	return { ...job, status: 'failed', fatalError: reason };
}

/**
 * Pure reducer applying one progress event to a job's client-side state.
 * Mirrors the D1 state transitions the Durable Object applies server-side
 * (see src/lib/server/import/jobs.ts) — kept as a pure function so the
 * client can render optimistically off the same WebSocket message it
 * forwards to the Worker, without waiting on a round-trip re-fetch.
 */
export function applyImportEvent(job: ImportJobState, event: ImportProgressEvent): ImportJobState {
	switch (event.type) {
		case 'start':
			return applyStart(job, event.totalCount);
		case 'probing_progress':
			return applyProbingProgress(job, event.checked, event.total);
		case 'preview':
			return applyPreview(job, event.entries);
		case 'song_success':
			return applySongSuccess(job);
		case 'song_known':
			// Same effect on client-side state as song_success: it counts
			// toward completedCount either way (see recordKnownSongLinked),
			// the only difference is server-side (no new `songs` row to
			// write, since the video_id already existed).
			return applySongSuccess(job);
		case 'song_failed':
			return applySongFailed(job, event.failure);
		case 'complete':
			return applyComplete(job);
		case 'fatal_error':
			return applyFatalError(job, event.reason);
	}
}
