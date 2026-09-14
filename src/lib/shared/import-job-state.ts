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
}

function applyStart(job: ImportJobState, totalCount: number): ImportJobState {
	return { ...job, status: 'running', totalCount };
}

function applyPreview(job: ImportJobState, entries: PreviewEntry[]): ImportJobState {
	return { ...job, status: 'pending_confirmation', previewEntries: entries };
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
		case 'preview':
			return applyPreview(job, event.entries);
		case 'song_success':
			return applySongSuccess(job);
		case 'song_failed':
			return applySongFailed(job, event.failure);
		case 'complete':
			return applyComplete(job);
	}
}
