import type { ImportProgressMessage, ImportControlMessage, ImportJobStatus } from '$lib/shared/import-events';
import { applyImportEvent, type ImportJobState } from '$lib/shared/import-job-state';

export type { ImportJobState };

interface RawImportJob {
	id: string;
	sourceUrl: string;
	status: ImportJobStatus;
	totalCount: number | null;
	completedCount: number;
	failedCount: number;
	failures: string | null;
	previewEntries: string | null;
	fatalError: string | null;
}

function parseJobRow(row: RawImportJob): ImportJobState {
	return {
		jobId: row.id,
		sourceUrl: row.sourceUrl,
		status: row.status,
		totalCount: row.totalCount,
		completedCount: row.completedCount,
		failedCount: row.failedCount,
		failures: row.failures ? JSON.parse(row.failures) : [],
		previewEntries: row.previewEntries ? JSON.parse(row.previewEntries) : null,
		fatalError: row.fatalError,
		// A server-fetched row is always past the probing phase (it's either
		// not started, or already has totalCount/previewEntries) — probing
		// progress only ever exists transiently client-side from a live event.
		probing: null
	};
}

const RECONNECT_DELAY_MS = 2000;

class ImportStore {
	jobs = $state<Map<string, ImportJobState>>(new Map());

	private socket: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private closedByUser = false;

	connect(): void {
		if (this.socket) return;
		this.closedByUser = false;
		this.openSocket();
	}

	disconnect(): void {
		this.closedByUser = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.socket?.close();
		this.socket = null;
	}

	/** Seeds (or replaces) a job's state from a server-fetched row, e.g. on page load or reconnect. */
	setJobFromServer(row: RawImportJob): void {
		const next = new Map(this.jobs);
		next.set(row.id, parseJobRow(row));
		this.jobs = next;
	}

	cancel(jobId: string): void {
		this.send({ jobId, action: 'cancel' });
	}

	private send(message: ImportControlMessage): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(message));
		}
	}

	private openSocket(): void {
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		this.socket = new WebSocket(`${protocol}//${location.host}/api/import/ws`);

		this.socket.addEventListener('message', (event) => {
			const message: ImportProgressMessage = JSON.parse(event.data);
			const existing = this.jobs.get(message.jobId);
			if (!existing) return;

			const updated = applyImportEvent(existing, message.event);
			const next = new Map(this.jobs);
			// The import page only shows currently-in-progress jobs, and a
			// completed/cancelled job's outcome needs no further explanation
			// — but a failure needs to stay visible with its reason (see
			// fatalError/failures) until the user dismisses it, or the only
			// place to learn what happened is the admin audit log.
			if (updated.status === 'completed' || updated.status === 'cancelled') {
				next.delete(message.jobId);
			} else {
				next.set(message.jobId, updated);
			}
			this.jobs = next;
		});

		this.socket.addEventListener('close', () => {
			this.socket = null;
			if (this.closedByUser) return;
			this.reconnectTimer = setTimeout(() => this.openSocket(), RECONNECT_DELAY_MS);
		});
	}
}

export const importStore = new ImportStore();
