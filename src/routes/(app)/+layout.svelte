<script lang="ts">
	import { onMount } from 'svelte';
	import { syncLibrarySnapshot } from '$lib/client/offline-cache';
	import AppShell from '$lib/components/app-shell.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	onMount(() => {
		// Keeps the offline copy of the library's structure current. Done here
		// rather than on one page so it refreshes wherever the reader happens
		// to go while they still have a connection.
		void syncLibrarySnapshot();
	});
</script>

<AppShell
	sidebarPlaylists={data.sidebarPlaylists}
	sidebarSmartPlaylists={data.sidebarSmartPlaylists}
>
	{@render children()}
</AppShell>
