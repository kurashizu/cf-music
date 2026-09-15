<script lang="ts">
	import type { Snippet } from 'svelte';
	import ThrottledImage from '$lib/components/throttled-image.svelte';

	interface Props {
		coverUrls: string[];
		fallback: Snippet;
	}

	let { coverUrls, fallback }: Props = $props();
</script>

{#if coverUrls.length >= 4}
	<div class="grid size-full grid-cols-2 grid-rows-2 gap-px">
		{#each coverUrls.slice(0, 4) as url (url)}
			<ThrottledImage src={url} class="size-full object-cover" />
		{/each}
	</div>
{:else if coverUrls.length > 0}
	<ThrottledImage src={coverUrls[0]} class="size-full object-cover" />
{:else}
	{@render fallback()}
{/if}
