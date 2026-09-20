<script lang="ts">
	import { throttledFetchBlobUrl, releaseBlobUrl } from '$lib/client/image-throttle';
	import { motionParams } from '$lib/client/motion';
	import { fade } from 'svelte/transition';

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
		// image up) so switching covers shows the skeleton, not a stale
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

{#if blobUrl}
	<img src={blobUrl} {alt} class={className} transition:fade={motionParams({ duration: 150 })} />
{:else}
	<!-- Deliberately a static fill, not animate-pulse: a long list renders one
	     of these per un-resolved cover, and dozens of simultaneous CSS
	     animations measurably cost frames while scrolling on mobile. -->
	<div class="{className} bg-muted"></div>
{/if}
