/** What a row renders. Deliberately only the fields a row actually shows. */
export interface SongRowData {
	videoId: string;
	title: string;
	durationSeconds: number | null;
	coverUrl: string | null;
	codec: string | null;
	bitrateKbps: number | null;
	embeddingStatus: string | null;
	/**
	 * Extra line under the title, where a list has something to say about the
	 * song that the shared fields don't cover — the storage page shows each
	 * song's file size here. Omitted everywhere else, and the row falls back
	 * to its usual duration line.
	 */
	detail?: string;
}

/**
 * Per-row presentation state, all resolved by the list that owns the rows.
 *
 * Rows are told what they are rather than working it out: a row that reads
 * the player store, the selection set and the drag state directly ends up
 * coupled to all three, which is what made the previous list impossible to
 * change safely.
 */
export interface SongRowFlags {
	selected: boolean;
	/** This row's track is the one loaded in the player. */
	current: boolean;
	playing: boolean;
	cached: boolean;
	downloading: boolean;
	/**
	 * Some operation is running on this song — a delete or a cache clear as
	 * well as a download. Distinct from `downloading`, which additionally
	 * means "show a download spinner": a row being deleted should be inert
	 * without pretending to download.
	 */
	busy: boolean;
	menuOpen: boolean;
	draggable: boolean;
	dragging: boolean;
	/** CSS order during a drag, or null when no drag is in progress. */
	dragOrder: number | null;
	/** This list supports reordering at all — false on views with no stored order. */
	reorderable: boolean;
	/** Reordering is available right now (not filtered, fully loaded, ...). */
	canReorder: boolean;
	canRemove: boolean;
	/** Whether copying/moving is available here at all — false offline. */
	canCopy: boolean;
	isFirst: boolean;
	isLast: boolean;
	/** Offers "Clear from cache" in the menu; pairs with actions.onClearCache. */
	canClearCache: boolean;
}

/** Everything a row can ask the list to do. */
export interface SongRowActions {
	onSelect: (event: MouseEvent) => void;
	onPlay: () => void;
	onDownload: () => void;
	onMenuOpenChange: (open: boolean) => void;
	onAddToQueue: () => void;
	onCopy: () => void;
	onMove: () => void;
	onRemove: () => void;
	onDelete: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
	onDragStart: () => void;
	onDragOver: (event: DragEvent) => void;
	onDragEnd: () => void;
	onClearCache: () => void;
}
