import { describe, it, expect } from 'vitest';
import { isImportEventBody } from './event-body';

describe('isImportEventBody', () => {
	it.each(['start', 'song_success', 'song_failed', 'complete'])('accepts type "%s"', (type) => {
		expect(isImportEventBody({ type })).toBe(true);
	});

	it('rejects an unrecognized type string', () => {
		expect(isImportEventBody({ type: 'unknown_event' })).toBe(false);
	});

	it('rejects a non-object body', () => {
		expect(isImportEventBody('start')).toBe(false);
	});

	it('rejects a non-object body even when it happens to carry a matching type property', () => {
		// Isolates the outer `typeof value !== 'object'` guard: functions are
		// typeof 'function', not 'object', yet can carry arbitrary own
		// properties.
		const bodyLikeAFunction = Object.assign(() => {}, { type: 'start' });
		expect(isImportEventBody(bodyLikeAFunction)).toBe(false);
	});

	it('rejects null', () => {
		expect(isImportEventBody(null)).toBe(false);
	});

	it('rejects a body missing the type field', () => {
		expect(isImportEventBody({})).toBe(false);
	});

	it('rejects a body whose type is not a string', () => {
		expect(isImportEventBody({ type: 123 })).toBe(false);
	});

	it('accepts extra fields alongside a valid type', () => {
		expect(isImportEventBody({ type: 'start', totalCount: 10 })).toBe(true);
	});
});
