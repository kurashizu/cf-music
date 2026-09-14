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
}

export interface SongImportFailureInput {
	videoId: string;
	reason: string;
}

export type ImportProgressEvent =
	| { type: 'start'; totalCount: number }
	| { type: 'preview'; entries: PreviewEntry[] }
	| { type: 'song_success'; song: SongImportSuccess }
	| { type: 'song_failed'; failure: SongImportFailureInput }
	| { type: 'complete' };

export interface ImportProgressMessage {
	jobId: string;
	event: ImportProgressEvent;
}

export interface ImportControlMessage {
	jobId: string;
	action: 'cancel';
}

export type ImportJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
