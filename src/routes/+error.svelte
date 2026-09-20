<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import Logo from '$lib/components/logo.svelte';
	import CloudOffIcon from '@lucide/svelte/icons/cloud-off';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';

	/**
	 * Without this, a navigation that can't reach the server rendered
	 * SvelteKit's own bare "500 Internal Error" — black text on black, no
	 * shell, no way back. Offline that is the *expected* outcome for any
	 * server-backed route, not a fault, so it says so and offers the
	 * downloads instead.
	 *
	 * The check runs on mount rather than during render: navigator.onLine is
	 * a browser fact the server can't know, and guessing wrong during SSR
	 * would flash the wrong message.
	 */
	let offline = $state(false);

	onMount(() => {
		offline = !navigator.onLine;
		const onOnline = () => (offline = false);
		const onOffline = () => (offline = true);
		window.addEventListener('online', onOnline);
		window.addEventListener('offline', onOffline);
		return () => {
			window.removeEventListener('online', onOnline);
			window.removeEventListener('offline', onOffline);
		};
	});
</script>

<svelte:head>
	<title>{offline ? 'Offline' : `${page.status} · KRSZ Music`}</title>
</svelte:head>

<div class="bg-background flex min-h-svh flex-col">
	<header class="border-border flex shrink-0 items-center gap-2 border-b p-3">
		<Logo size={22} />
		<span class="text-sm font-medium">KRSZ Music</span>
	</header>

	<div class="flex flex-1 items-center justify-center p-6">
		<div class="flex max-w-sm flex-col items-center gap-3 text-center">
			{#if offline}
				<CloudOffIcon class="text-muted-foreground size-8" />
				<h1 class="text-lg font-medium">You're offline</h1>
				<p class="text-muted-foreground text-sm">
					This page needs a connection. Your downloaded songs are still here.
				</p>
				<Button href="/offline" size="sm" class="mt-2 gap-1.5">Go to downloads</Button>
			{:else}
				<TriangleAlertIcon class="text-muted-foreground size-8" />
				<h1 class="text-lg font-medium">{page.status}</h1>
				<p class="text-muted-foreground text-sm">
					{page.error?.message ?? 'Something went wrong.'}
				</p>
				<div class="mt-2 flex items-center gap-2">
					<Button href="/library" size="sm" variant="outline">Back to library</Button>
					<Button size="sm" class="gap-1.5" onclick={() => location.reload()}>
						<RefreshCwIcon class="size-4" />
						Retry
					</Button>
				</div>
			{/if}
		</div>
	</div>
</div>
