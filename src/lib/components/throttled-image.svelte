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
	<img src={blobUrl} {alt} class={className} />
{/if}
