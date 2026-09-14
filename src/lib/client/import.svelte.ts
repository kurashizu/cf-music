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
		previewEntries: row.previewEntries ? JSON.parse(row.previewEntries) : null
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

	confirm(jobId: string, approved: boolean): void {
		this.send({ jobId, action: 'confirm', approved });
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

			const next = new Map(this.jobs);
			next.set(message.jobId, applyImportEvent(existing, message.event));
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
