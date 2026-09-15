<script lang="ts">
	import { player } from '$lib/client/player.svelte';
	import { queuePanelState } from '$lib/client/queue-panel-state.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import LayersIcon from '@lucide/svelte/icons/layers';
</script>

<Button
	variant="ghost"
	size="icon-sm"
	class="relative transition-colors {player.upcoming.length > 0 ? 'text-foreground' : 'text-muted-foreground'}"
	onclick={() => (queuePanelState.open = !queuePanelState.open)}
	aria-label="Queue"
	aria-expanded={queuePanelState.open}
>
	<LayersIcon class="size-4" />
	{#if player.upcoming.length > 0}
		<span
			class="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-foreground text-[9px] font-medium text-background"
		>
			{player.upcoming.length > 9 ? '9+' : player.upcoming.length}
		</span>
	{/if}
</Button>
