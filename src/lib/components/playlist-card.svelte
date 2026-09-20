<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import PlaylistCover from '$lib/components/playlist-cover.svelte';

	interface Props {
		name: string;
		/** Up to four member covers, for the mosaic thumbnail. */
		coverUrls: string[];
		/** The line under the name, e.g. "12 songs" or "Your whole library · 365 songs". */
		subtitle: string;
		/**
		 * Drawn when the playlist has no covers to show.
		 *
		 * Deliberately not named `fallback`: PlaylistCover's own slot is called
		 * that, and a same-named snippet inside it shadows the prop — which
		 * made `{@render fallback()}` recurse into itself until the render
		 * stack blew, surfacing as a 500 on the library page.
		 */
		emptyIcon: Snippet;
		/** Where the card links to. Omitted when `onclick` handles it instead. */
		href?: string;
		/**
		 * Opens the playlist without navigating — the offline page shows it in
		 * place, since there is no playlist route to reach without a server.
		 */
		onclick?: () => void;
		/** A per-card menu, e.g. rename/delete. Positioned by this component. */
		menu?: Snippet;
	}

	let { name, coverUrls, subtitle, emptyIcon, href, onclick, menu }: Props = $props();
</script>

<!--
	The library index, the two smart-playlist sections and the offline page all
	drew this card themselves. They differed only in the fallback icon, the
	subtitle and whether a menu was attached, so those are the props; everything
	else was four copies of the same markup drifting apart.
-->
{#snippet body()}
	<div
		class="bg-muted flex aspect-square items-center justify-center overflow-hidden rounded-lg transition-transform duration-200 group-hover:scale-[1.02] group-active:scale-[1.02]"
	>
		<PlaylistCover {coverUrls}>
			{#snippet fallback()}
				{@render emptyIcon()}
			{/snippet}
		</PlaylistCover>
	</div>
	<div class="min-w-0">
		<p class="truncate text-sm font-medium">{name}</p>
		<p class="text-muted-foreground truncate text-xs">{subtitle}</p>
	</div>
{/snippet}

<Card.Root
	class="group active:border-ring/50 hover:border-ring/50 relative overflow-hidden py-0 transition-colors"
>
	{#if href}
		<a {href} class="flex flex-col gap-3 p-3 sm:p-4">
			{@render body()}
		</a>
	{:else}
		<button type="button" class="flex w-full flex-col gap-3 p-3 text-left sm:p-4" {onclick}>
			{@render body()}
		</button>
	{/if}

	{#if menu}
		{@render menu()}
	{/if}
</Card.Root>
