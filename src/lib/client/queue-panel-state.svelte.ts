/** Shared open/closed state for the queue panel — split from queue-panel.svelte
 * so its trigger button can live inline in the player bar's own button row
 * while the popover itself still renders as an independent fixed-position
 * sibling (see that component for why: a shared wrapper sized to fit the
 * wider panel pushed the narrower trigger button out of its row).
 *
 * anchorRect is the trigger button's own bounding rect, captured at click
 * time — the player bar isn't a fixed-height element (it wraps whatever
 * content it has), so a hardcoded bottom offset drifts out of sync with
 * its real height across breakpoints/content changes. Reading the actual
 * button position keeps the panel flush against it regardless.
 */
class QueuePanelState {
	open = $state(false);
	anchorRect = $state<DOMRect | null>(null);
}

export const queuePanelState = new QueuePanelState();
