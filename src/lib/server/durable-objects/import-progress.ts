import { getDb } from '../db';
import {
	getImportJobUnchecked,
	startImportJob,
	submitImportPreview,
	recordSongImported,
	recordKnownSongLinked,
	recordSongFailed,
	completeImportJob,
	failImportJob,
	disconnectImportJob,
	cancelImportJob,
	ImportJobError
} from '../import/jobs';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
import type {
	ImportProgressMessage as CiProgressMessage,
	ImportControlMessage as BrowserControlMessage
} from '../../shared/import-events';

export type {
	ImportProgressEvent,
	PreviewEntry,
	SongImportSuccess,
	SongImportFailureInput
} from '../../shared/import-events';

function ciTag(jobId: string): string {
	return `ci:${jobId}`;
}

function isCiSocket(tags: string[]): boolean {
	return tags.some((t) => t.startsWith('ci:'));
}

/**
 * Per-user Durable Object bridging a browser's WebSocket connection with a
 * GitHub Actions import job's own WebSocket connection — both sides connect
 * directly to this DO (GitHub Actions runners have no public inbound
 * address, so they connect out to here rather than the other way around).
 * D1 (import_jobs table) is updated directly from here as CI's progress
 * events arrive, then the same event is broadcast to every browser tab; a
 * browser's confirm/cancel decision is routed back to that job's specific
 * CI connection by its `ci:{jobId}` tag, so concurrent imports for the same
 * user don't cross-talk.
 *
 * Uses the WebSocket Hibernation API (ctx.acceptWebSocket) rather than
 * server.accept(): an idle DO can be evicted from memory between updates
 * without dropping either connection or incurring duration charges;
 * ctx.getWebSockets(tag) finds the right connections again after
 * hibernation without needing a separate lookup table.
 */
export class ImportProgressDurableObject implements DurableObject {
	// handleCiProgress previously re-fetched the whole import_jobs row on
	// every single progress message just to read this one immutable field
	// (userId is set at job creation and never updated) — a long import
	// sends one message per song, so this turned a several-hundred-song
	// import into several hundred redundant full-row reads. Scoped to this
	// DO instance's in-memory lifetime only: a rare cache miss after
	// hibernation just re-fetches once, which is correct either way since
	// userId can't have changed.
	private readonly jobUserIdCache = new Map<string, string>();

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env
	) {}

	private async getJobUserId(db: ReturnType<typeof getDb>, jobId: string): Promise<string> {
		const cached = this.jobUserIdCache.get(jobId);
		if (cached) return cached;
		const job = await getImportJobUnchecked(db, jobId);
		this.jobUserIdCache.set(jobId, job.userId);
		return job.userId;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		}

		const url = new URL(request.url);
		const role = url.searchParams.get('role');

		if (role === 'ci') {
			const jobId = url.searchParams.get('jobId');
			if (!jobId) return new Response('jobId is required', { status: 400 });
			return this.acceptConnection([ciTag(jobId)]);
		}

		return this.acceptConnection([]);
	}

	private acceptConnection(tags: string[]): Response {
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		this.ctx.acceptWebSocket(server, tags);

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== 'string') return;

		const tags = this.ctx.getTags(ws);
		if (isCiSocket(tags)) {
			await this.handleCiProgress(message);
		} else {
			await this.handleBrowserControl(message);
		}
	}

	private async handleCiProgress(raw: string): Promise<void> {
		let message: CiProgressMessage;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}

		const db = getDb(this.env.DB);

		// 'start' can arrive before this job's userId has ever been looked up
		// (it's the very first message a CI connection sends), and startImportJob
		// itself doesn't need it — so the cache is only populated lazily, from
		// whichever message actually needs userId first.
		if (message.event.type === 'start') {
			try {
				await startImportJob(db, message.jobId, message.event.totalCount);
			} catch (err) {
				if (err instanceof ImportJobError) return;
				throw err;
			}
			this.broadcastToBrowsers(raw);
			return;
		}

		let userId: string;
		try {
			userId = await this.getJobUserId(db, message.jobId);
		} catch (err) {
			if (err instanceof ImportJobError) return;
			throw err;
		}

		switch (message.event.type) {
			case 'preview':
				await submitImportPreview(db, message.jobId, message.event.entries);
				break;
			case 'song_success':
				await recordSongImported(db, message.jobId, userId, message.event.song);
				break;
			case 'song_known':
				await recordKnownSongLinked(db, message.jobId, userId, message.event.videoId);
				break;
			case 'song_failed':
				await recordSongFailed(db, message.jobId, userId, message.event.failure);
				break;
			case 'complete':
				await completeImportJob(db, message.jobId, userId);
				break;
			case 'fatal_error':
				await failImportJob(db, message.jobId, userId, message.event.reason);
				break;
		}

		this.broadcastToBrowsers(raw);
	}

	// Broadcast the raw event straight through to every browser tab — the
	// frontend re-fetches full job state via GET /api/import/[jobId] on
	// (re)connect, so this only needs to carry "something changed".
	private broadcastToBrowsers(raw: string): void {
		for (const browserWs of this.ctx.getWebSockets()) {
			if (!isCiSocket(this.ctx.getTags(browserWs))) {
				browserWs.send(raw);
			}
		}
	}

	private async handleBrowserControl(raw: string): Promise<void> {
		let control: BrowserControlMessage;
		try {
			control = JSON.parse(raw);
		} catch {
			return;
		}

		const db = getDb(this.env.DB);
		const ciSockets = this.ctx.getWebSockets(ciTag(control.jobId));

		try {
			// This DO instance is keyed by idFromName(userId) — see
			// /api/import/ws, which only lets a browser reach this instance
			// after checking its own session cookie — so any browser socket
			// connected here already belongs to this job's owner. The
			// ownership check inside cancelImportJob is therefore redundant
			// defense-in-depth, not the primary guard.
			const job = await getImportJobUnchecked(db, control.jobId);
			await cancelImportJob(db, control.jobId, job.userId);
		} catch (err) {
			if (!(err instanceof ImportJobError)) throw err;
			return;
		}

		for (const ciWs of ciSockets) {
			ciWs.send(raw);
		}

		// A still-running job also learns about this via CI's own eventual
		// fatal_error/complete once it sees the forwarded cancel above — but
		// a job with no CI connection left (already completed/failed, e.g.
		// dismissing a failed job) has no such follow-up event coming. This
		// broadcast is what lets the browser that requested the cancel
		// actually see the job disappear in that case, instead of it
		// silently staying stuck at 'failed' in the UI even though the D1
		// row is already 'cancelled'.
		const cancelledMessage: CiProgressMessage = {
			jobId: control.jobId,
			event: { type: 'cancelled' }
		};
		const cancelledRaw = JSON.stringify(cancelledMessage);
		for (const browserWs of this.ctx.getWebSockets()) {
			if (!isCiSocket(this.ctx.getTags(browserWs))) {
				browserWs.send(cancelledRaw);
			}
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		await this.handlePossibleZombieJob(ws);
		ws.close(code, reason);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.handlePossibleZombieJob(ws);
	}

	/**
	 * The CI process's own WebSocket is the *only* way a job ever reaches a
	 * terminal status — `complete`/`fatal_error` are both just messages on
	 * this same connection (see handleCiProgress). If that connection ends
	 * for any other reason (network drop, the runner getting killed, an
	 * uncaught exception before the process's own top-level handler can
	 * send fatal_error) the job is left stuck at `running`/`pending`
	 * forever, with no automatic way to notice — this was a real incident
	 * (a WebSocket disconnect during a long-running batch left the job
	 * spinning in the UI with nothing to cancel it automatically). A CI
	 * socket closing while its job is still non-terminal is exactly that
	 * situation, so it's treated as an implicit disconnect (see
	 * disconnectImportJob for why this isn't always a hard failure — a
	 * disconnect after real progress keeps that progress instead of
	 * discarding it).
	 */
	private async handlePossibleZombieJob(ws: WebSocket): Promise<void> {
		const tags = this.ctx.getTags(ws);
		const ciTagValue = tags.find((t) => t.startsWith('ci:'));
		if (!ciTagValue) return;

		const jobId = ciTagValue.slice('ci:'.length);
		const db = getDb(this.env.DB);

		let job;
		try {
			job = await getImportJobUnchecked(db, jobId);
		} catch (err) {
			if (err instanceof ImportJobError) return;
			throw err;
		}
		if (TERMINAL_STATUSES.has(job.status)) return;

		const reason = 'Import process disconnected unexpectedly';
		await disconnectImportJob(db, jobId, job.userId, reason);

		// completedCount > 0 at disconnect time is exactly disconnectImportJob's
		// own branch condition for resolving to `completed` instead of
		// `failed` — reusing it here keeps the broadcast event in sync with
		// whichever branch the D1 write actually took, without a second
		// read back.
		const event = job.completedCount > 0 ? { type: 'complete' } : { type: 'fatal_error', reason };
		const raw = JSON.stringify({ jobId, event });
		for (const browserWs of this.ctx.getWebSockets()) {
			if (!isCiSocket(this.ctx.getTags(browserWs))) {
				browserWs.send(raw);
			}
		}
	}
}
