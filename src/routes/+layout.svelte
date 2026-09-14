<script lang="ts">
	import { onMount } from 'svelte';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { registerServiceWorker } from '$lib/client/service-worker-register';

	let { children } = $props();

	onMount(() => {
		registerServiceWorker();
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}
