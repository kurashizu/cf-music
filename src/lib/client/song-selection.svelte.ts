/**
 * Multi-select over a list of songs.
 *
 * Owns only which video ids are selected and how a click changes that. It is
 * given the ids a click applies to rather than reading any list itself, so
 * selection can't drift out of step with paging, sorting or filtering the way
 * it did when every one of those reached into the same state.
 */
export class SongSelection {
	private selectedIds = $state<Set<string>>(new Set());
	private anchor: string | null = null;

	get ids(): Set<string> {
		return this.selectedIds;
	}

	get size(): number {
		return this.selectedIds.size;
	}

	has(videoId: string): boolean {
		return this.selectedIds.has(videoId);
	}

	clear(): void {
		this.selectedIds = new Set();
		this.anchor = null;
	}

	/**
	 * Applies a click.
	 *
	 * `visibleIds` is the ids currently on screen, in display order — shift
	 * selects the span between the last click and this one *as shown*, which
	 * is what a reader means by "everything between these two", regardless of
	 * where those songs sit in the underlying playlist.
	 */
	click(
		videoId: string,
		event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
		visibleIds: string[]
	): void {
		if (event.shiftKey && this.anchor !== null) {
			const from = visibleIds.indexOf(this.anchor);
			const to = visibleIds.indexOf(videoId);
			if (from !== -1 && to !== -1) {
				const [start, end] = from <= to ? [from, to] : [to, from];
				const next = new Set(this.selectedIds);
				for (const id of visibleIds.slice(start, end + 1)) next.add(id);
				this.selectedIds = next;
				return;
			}
		}

		if (event.metaKey || event.ctrlKey) {
			const next = new Set(this.selectedIds);
			if (next.has(videoId)) next.delete(videoId);
			else next.add(videoId);
			this.selectedIds = next;
			this.anchor = videoId;
			return;
		}

		// A plain click on the only selected row clears it, so there is a way
		// out of selection without reaching for a modifier.
		const isOnlySelection = this.selectedIds.size === 1 && this.selectedIds.has(videoId);
		this.selectedIds = isOnlySelection ? new Set() : new Set([videoId]);
		this.anchor = isOnlySelection ? null : videoId;
	}

	/** Selects every id given, or clears if they are all already selected. */
	toggleAll(visibleIds: string[]): void {
		const allSelected = visibleIds.length > 0 && visibleIds.every((id) => this.selectedIds.has(id));
		this.selectedIds = allSelected ? new Set() : new Set(visibleIds);
		this.anchor = allSelected ? null : (visibleIds[visibleIds.length - 1] ?? null);
	}

	/** Drops ids that no longer exist, e.g. after songs are removed. */
	retain(existingIds: Set<string>): void {
		const next = new Set([...this.selectedIds].filter((id) => existingIds.has(id)));
		if (next.size !== this.selectedIds.size) this.selectedIds = next;
	}
}
