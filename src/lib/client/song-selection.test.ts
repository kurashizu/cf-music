import { describe, it, expect, beforeEach } from 'vitest';
import { SongSelection } from './song-selection.svelte';

const PLAIN = { shiftKey: false, metaKey: false, ctrlKey: false };
const SHIFT = { shiftKey: true, metaKey: false, ctrlKey: false };
const META = { shiftKey: false, metaKey: true, ctrlKey: false };

const VISIBLE = ['a', 'b', 'c', 'd', 'e'];

describe('SongSelection', () => {
	let selection: SongSelection;
	beforeEach(() => {
		selection = new SongSelection();
	});

	it('selects a single song, replacing any previous selection', () => {
		selection.click('a', PLAIN, VISIBLE);
		selection.click('c', PLAIN, VISIBLE);
		expect([...selection.ids]).toEqual(['c']);
	});

	it('clears when clicking the only selected song', () => {
		selection.click('a', PLAIN, VISIBLE);
		selection.click('a', PLAIN, VISIBLE);
		expect(selection.size).toBe(0);
	});

	it('adds and removes individually with a modifier', () => {
		selection.click('a', META, VISIBLE);
		selection.click('c', META, VISIBLE);
		expect([...selection.ids].sort()).toEqual(['a', 'c']);
		selection.click('a', META, VISIBLE);
		expect([...selection.ids]).toEqual(['c']);
	});

	it('selects the span between two clicks as displayed', () => {
		selection.click('b', PLAIN, VISIBLE);
		selection.click('d', SHIFT, VISIBLE);
		expect([...selection.ids].sort()).toEqual(['b', 'c', 'd']);
	});

	it('selects the same span when shift-clicking backwards', () => {
		selection.click('d', PLAIN, VISIBLE);
		selection.click('b', SHIFT, VISIBLE);
		expect([...selection.ids].sort()).toEqual(['b', 'c', 'd']);
	});

	it('falls back to a plain selection when the anchor scrolled out of view', () => {
		selection.click('a', PLAIN, VISIBLE);
		// 'a' is no longer rendered, so there is no span to resolve.
		selection.click('d', SHIFT, ['c', 'd', 'e']);
		expect([...selection.ids]).toEqual(['d']);
	});

	it('toggles everything visible', () => {
		selection.toggleAll(VISIBLE);
		expect(selection.size).toBe(5);
		selection.toggleAll(VISIBLE);
		expect(selection.size).toBe(0);
	});

	it('drops ids that no longer exist', () => {
		selection.toggleAll(VISIBLE);
		selection.retain(new Set(['a', 'b']));
		expect([...selection.ids].sort()).toEqual(['a', 'b']);
	});
});
