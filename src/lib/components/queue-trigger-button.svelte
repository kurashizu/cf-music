<script lang="ts">
	import { player } from '$lib/client/player.svelte';
	import { queuePanelState } from '$lib/client/queue-panel-state.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import { scale } from 'svelte/transition';
	import { motionParams } from '$lib/client/motion';

	// bits-ui's Tooltip.Trigger child snippet already owns a `ref` binding
	// on `props` internally (it needs the element to position the tooltip)
	// — a second bind:ref on the same element for our own purposes throws
	// ("Cannot do bind:ref={undefined} when ref has a fallback value"),
	// so the anchor position is captured from the click event's own
	// target instead of a separate ref.
	function toggle(event: MouseEvent) {
		const target = event.currentTarget as HTMLElement;
		queuePanelState.anchorRect = target.getBoundingClientRect();
		queuePanelState.open = !queuePanelState.open;
	}
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon-sm"
				class="relative transition-colors {player.upcoming.length > 0
					? 'text-foreground'
					: 'text-muted-foreground'}"
				onclick={toggle}
				aria-label="Queue"
				aria-expanded={queuePanelState.open}
			>
				<LayersIcon class="size-4" />
				{#if player.upcoming.length > 0}
					<span
						class="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-foreground text-[9px] font-medium text-background"
						transition:scale={motionParams({ duration: 100, start: 0.5 })}
					>
						{player.upcoming.length > 9 ? '9+' : player.upcoming.length}
					</span>
				{/if}
			</Button>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content>Queue</Tooltip.Content>
</Tooltip.Root>
