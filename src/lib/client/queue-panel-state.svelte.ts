/** Shared open/closed state for the queue panel — split from queue-panel.svelte
 * so its trigger button can live inline in the player bar's own button row
 * while the popover itself still renders as an independent fixed-position
 * sibling (see that component for why: a shared wrapper sized to fit the
 * wider panel pushed the narrower trigger button out of its row). */
class QueuePanelState {
	open = $state(false);
}

export const queuePanelState = new QueuePanelState();
