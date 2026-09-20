<script lang="ts">
	import { throttledFetchBlobUrl, releaseBlobUrl } from '$lib/client/image-throttle';

	interface Props {
		src: string;
		alt?: string;
		class?: string;
	}

	let { src, alt = '', class: className = '' }: Props = $props();

	let blobUrl: string | undefined = $state();

	$effect(() => {
		const requestedSrc = src;
		let acquired = false;
		let cancelled = false;
		// Reset immediately on src change (rather than leaving the old
		// image up) so switching covers shows the placeholder, not a stale
		// mismatched thumbnail, while the new blob URL resolves.
		blobUrl = undefined;

		throttledFetchBlobUrl(requestedSrc).then((url) => {
			if (cancelled) {
				releaseBlobUrl(requestedSrc);
				return;
			}
			acquired = true;
			blobUrl = url;
		});

		return () => {
			cancelled = true;
			if (acquired) releaseBlobUrl(requestedSrc);
		};
	});
</script>

<!-- The placeholder stays mounted underneath rather than being swapped out,
     so the image fades in over a filled box instead of the two trading
     places — a hard swap is what made a scrolling list look like it was
     flickering as covers resolved.

     Deliberately a static fill, not animate-pulse: a long list renders one
     of these per un-resolved cover, and dozens of simultaneous CSS
     animations measurably cost frames while scrolling on mobile. -->
<div class="relative {className}">
	<div class="bg-muted absolute inset-0"></div>
	{#if blobUrl}
		<!-- A CSS transition on a stable element, not a Svelte one: the row
		     around this re-renders as the list loads and sorts, which would
		     restart an in: transition and leave covers stuck part-way faded. -->
		<img
			src={blobUrl}
			{alt}
			class="absolute inset-0 size-full object-cover opacity-0 transition-opacity duration-200"
			onload={(e) => e.currentTarget.classList.remove('opacity-0')}
		/>
	{/if}
</div>
