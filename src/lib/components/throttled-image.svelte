<script lang="ts">
	import { throttledFetchBlobUrl } from '$lib/client/image-throttle';

	interface Props {
		src: string;
		alt?: string;
		class?: string;
	}

	let { src, alt = '', class: className = '' }: Props = $props();

	let blobUrl: string | undefined = $state();

	$effect(() => {
		const requestedSrc = src;
		let currentBlobUrl: string | undefined;
		let cancelled = false;

		throttledFetchBlobUrl(requestedSrc).then((url) => {
			if (cancelled) {
				URL.revokeObjectURL(url);
				return;
			}
			currentBlobUrl = url;
			blobUrl = url;
		});

		return () => {
			cancelled = true;
			if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
		};
	});
</script>

{#if blobUrl}
	<img src={blobUrl} {alt} class={className} />
{/if}
