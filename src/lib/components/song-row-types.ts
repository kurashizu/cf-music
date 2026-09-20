/** What a row renders. Deliberately only the fields a row actually shows. */
export interface SongRowData {
	videoId: string;
	title: string;
	durationSeconds: number | null;
	coverUrl: string | null;
	codec: string | null;
	bitrateKbps: number | null;
	embeddingStatus: string | null;
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
	menuOpen: boolean;
	draggable: boolean;
	dragging: boolean;
	/** CSS order during a drag, or null when no drag is in progress. */
	dragOrder: number | null;
	canReorder: boolean;
	canRemove: boolean;
	hasOtherPlaylists: boolean;
	isFirst: boolean;
	isLast: boolean;
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
}
