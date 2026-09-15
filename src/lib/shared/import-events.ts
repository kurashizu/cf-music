// Wire-format types shared between the CI import script (documented for
// parity, not imported — Python has its own JSON shapes), the Worker/DO
// (src/lib/server/durable-objects/import-progress.ts), and the browser
// client (src/lib/client/import.svelte.ts). Kept under shared/ rather than
// server/ specifically so the browser side can import the same types
// instead of re-declaring a shape that could drift.

export interface PreviewEntry {
	videoId: string;
	title: string;
	durationSeconds?: number;
}

export interface SongImportSuccess {
	videoId: string;
	sourcePlatform: string;
	sourceUrl: string;
	title: string;
	durationSeconds?: number;
	audioKey: string;
	codec: string;
	container: string;
	bitrateKbps?: number;
	sampleRate?: number;
	fileSizeBytes: number;
	coverKey?: string;
	coverWidth?: number;
	coverHeight?: number;
	artist?: string;
	album?: string;
	genre?: string;
	releaseYear?: number;
	tags?: string[];
}

export interface SongImportFailureInput {
	videoId: string;
	reason: string;
}

export type ImportProgressEvent =
	| { type: 'start'; totalCount: number }
	// Sent once per song while the CI job probes each pending song's real
	// download size (before any downloading starts) — purely a keepalive +
	// UX signal for what would otherwise be a multi-minute silent gap on a
	// large playlist; the Worker doesn't need to persist this anywhere, it
	// just broadcasts it through to the browser like any other event (see
	// import-progress.ts).
	| { type: 'probing_progress'; checked: number; total: number }
	| { type: 'preview'; entries: PreviewEntry[] }
	| { type: 'song_success'; song: SongImportSuccess }
	// A song from the source that was already in the library (found via
	// findKnownVideoIds), so CI never downloaded it — only needs linking
	// into this job's target playlist, not a new `songs` row.
	| { type: 'song_known'; videoId: string }
	| { type: 'song_failed'; failure: SongImportFailureInput }
	| { type: 'complete' }
	// Something before/outside the per-song loop failed unrecoverably (e.g.
	// yt-dlp couldn't extract the source URL at all, or the WARP proxy never
	// came up) — distinct from song_failed, which is one song out of a batch
	// that's otherwise proceeding. Without this, a crash in that early phase
	// left the job stuck at its initial status forever: the CI process's own
	// stderr/exit code has no path back to the Worker, since exiting non-zero
	// just drops the WebSocket connection without saying why.
	| { type: 'fatal_error'; reason: string };

export interface ImportProgressMessage {
	jobId: string;
	event: ImportProgressEvent;
}

export interface ImportControlMessage {
	jobId: string;
	action: 'cancel';
}

export type ImportJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
