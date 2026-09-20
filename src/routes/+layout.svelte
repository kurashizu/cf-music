<script lang="ts">
	import { onMount } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { registerServiceWorker } from '$lib/client/service-worker-register';

	let { children } = $props();

	/**
	 * Routes that work with no connection.
	 *
	 * /settings earns its place: skip silence, clearing local data and the
	 * cache figures are all device-local, and it fetches its cloud totals
	 * separately so their absence degrades one card rather than the page.
	 */
	const OFFLINE_ROUTES = ['/offline', '/settings'];

	/**
	 * Sends a navigation to the downloads page when there is no connection.
	 *
	 * Every other route loads its data from the server, and a client-side
	 * navigation that can't reach it fails as a bare "500 Internal Error" —
	 * SvelteKit has no way to tell "the server is broken" from "there is no
	 * network". Catching it here means tapping Settings or Stats offline
	 * lands somewhere usable instead.
	 *
	 * Deliberately a redirect rather than a blocked navigation: leaving the
	 * reader on the page they tried to leave, with no feedback, reads as the
	 * tap not having registered.
	 */
	beforeNavigate((navigation) => {
		if (typeof navigator === 'undefined' || navigator.onLine) return;
		const path = navigation.to?.url.pathname;
		if (!path || OFFLINE_ROUTES.includes(path)) return;
		navigation.cancel();
		void goto('/offline');
	});

	onMount(() => {
		registerServiceWorker();
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}
