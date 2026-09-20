<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';
	import SearchIcon from '@lucide/svelte/icons/search';

	interface Props {
		value: string;
		placeholder: string;
		/** For searches that hit the server and so need debouncing. */
		oninput?: () => void;
	}

	let { value = $bindable(), placeholder, oninput }: Props = $props();
</script>

<!--
	The magnifier is positioned over the input rather than being part of it, so
	every page that had a search box repeated this wrapper and its padding
	offset. Six copies before this.
-->
<div class="relative min-w-48 flex-1">
	<SearchIcon class="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
	<Input {placeholder} bind:value {oninput} class="pl-9" />
</div>
