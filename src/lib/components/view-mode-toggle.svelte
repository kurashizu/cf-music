<script lang="ts">
	import { viewMode } from '$lib/client/view-mode.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import ListIcon from '@lucide/svelte/icons/list';
	import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
</script>

<div class="flex items-center rounded-lg border border-border p-0.5">
	<Button
		variant={viewMode.mode === 'list' ? 'secondary' : 'ghost'}
		size="icon-sm"
		onclick={() => viewMode.set('list')}
		aria-label="List view"
		aria-pressed={viewMode.mode === 'list'}
	>
		<ListIcon class="size-4" />
	</Button>
	<Button
		variant={viewMode.mode === 'grid' ? 'secondary' : 'ghost'}
		size="icon-sm"
		onclick={() => viewMode.set('grid')}
		aria-label="Grid view"
		aria-pressed={viewMode.mode === 'grid'}
	>
		<LayoutGridIcon class="size-4" />
	</Button>
</div>
