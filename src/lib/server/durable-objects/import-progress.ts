export interface ImportProgressMessage {
	jobId: string;
	status: 'pending' | 'running' | 'completed' | 'failed';
	totalCount: number | null;
	completedCount: number;
	failedCount: number;
}

/**
 * Per-user Durable Object tracking the real-time progress of that user's
 * concurrent import jobs. D1 (import_jobs table) remains the source of
 * truth; this is purely a broadcast layer — if the DO's state is ever lost,
 * the frontend can always fall back to polling GET /api/import-jobs/[id].
 *
 * Uses the WebSocket Hibernation API (ctx.acceptWebSocket) rather than
 * server.accept(): an idle DO can be evicted from memory between updates
 * without dropping the connection or incurring duration charges, and
 * ctx.getWebSockets() restores the accepted sockets after hibernation.
 *
 * Per-job state is persisted to ctx.storage (not a plain in-memory field)
 * specifically because hibernation wipes regular instance properties — only
 * ctx.storage and the accepted WebSockets themselves survive eviction.
 */
export class ImportProgressDurableObject implements DurableObject {
	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/report' && request.method === 'POST') {
			return this.handleReport(request);
		}

		if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocketUpgrade();
		}

		return new Response('Not found', { status: 404 });
	}

	private async handleWebSocketUpgrade(): Promise<Response> {
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		this.ctx.acceptWebSocket(server);

		// Replay every job's last-known state so a reconnecting client isn't
		// stuck showing stale progress from before it (re)connected.
		const stored = await this.ctx.storage.list<ImportProgressMessage>();
		for (const message of stored.values()) {
			server.send(JSON.stringify(message));
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	private async handleReport(request: Request): Promise<Response> {
		const message = (await request.json()) as ImportProgressMessage;

		await this.ctx.storage.put(message.jobId, message);

		const payload = JSON.stringify(message);
		for (const ws of this.ctx.getWebSockets()) {
			ws.send(payload);
		}

		return new Response(null, { status: 204 });
	}

	async webSocketMessage(): Promise<void> {
		// Clients don't send anything meaningful in this app; ignore.
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		ws.close(code, reason);
	}
}
