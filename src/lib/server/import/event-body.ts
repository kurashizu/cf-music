import type { SongImportSuccess, SongImportFailureInput } from './jobs';

export interface ImportEventBody {
	type: 'start' | 'song_success' | 'song_failed' | 'complete';
	totalCount?: number;
	song?: SongImportSuccess;
	failure?: SongImportFailureInput;
}

const VALID_TYPES = new Set(['start', 'song_success', 'song_failed', 'complete']);

export function isImportEventBody(value: unknown): value is ImportEventBody {
	if (typeof value !== 'object' || value === null) return false;

	// Set.has() uses strict equality with no coercion, so it already returns
	// false for any non-string value — an explicit `typeof type === 'string'`
	// check ahead of it would be redundant.
	const type = (value as Record<string, unknown>).type;
	return VALID_TYPES.has(type as string);
}
