<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import { estimateBrowserStorage, type StorageEstimate } from '$lib/client/offline-cache';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let browserStorage = $state<StorageEstimate | null>(null);

	async function handleLogout() {
		try {
			const response = await fetch('/api/auth/logout', { method: 'POST' });
			if (!response.ok) {
				toast.error('Failed to log out');
				return;
			}
			await invalidateAll();
			await goto('/');
		} catch {
			toast.error('Failed to log out');
		}
	}

	const usagePercent = $derived(
		data.quotaBytes > 0 ? Math.min(100, (data.usageBytes / data.quotaBytes) * 100) : 0
	);
	const browserUsagePercent = $derived(
		browserStorage && data.quotaBytes > 0
			? Math.min(100, (browserStorage.usageBytes / data.quotaBytes) * 100)
			: 0
	);

	onMount(() => {
		estimateBrowserStorage().then((estimate) => {
			browserStorage = estimate;
		});
	});

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		const units = ['KB', 'MB', 'GB'];
		let value = bytes / 1024;
		let unitIndex = 0;
		while (value >= 1024 && unitIndex < units.length - 1) {
			value /= 1024;
			unitIndex++;
		}
		return `${value.toFixed(1)} ${units[unitIndex]}`;
	}
</script>

<svelte:head>
	<title>Settings · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-2xl p-4 md:p-8">
	<h1 class="mb-6 text-lg font-medium">Settings</h1>

	<a href="/settings/storage" class="mb-4 block">
		<Card.Root class="transition-colors hover:border-ring/50">
			<Card.Content>
				<div class="mb-2 flex items-center justify-between text-sm">
					<span class="flex items-center gap-1.5 text-muted-foreground">
						<HardDriveIcon class="size-4" />
						Manage storage
					</span>
					<div class="flex items-center gap-1.5 text-muted-foreground">
						<span>{formatBytes(data.usageBytes)} / {formatBytes(data.quotaBytes)} cloud</span>
						<ChevronRightIcon class="size-4 shrink-0" />
					</div>
				</div>
				<div class="h-1.5 overflow-hidden rounded-full bg-muted">
					<div class="h-full bg-foreground transition-all duration-300" style="width: {usagePercent}%"></div>
				</div>
				{#if browserStorage}
					<div class="mt-2 flex items-center justify-between text-xs text-muted-foreground">
						<span class="flex items-center gap-1.5">
							<GlobeIcon class="size-3.5" />
							Offline cache
						</span>
						<span>{formatBytes(browserStorage.usageBytes)} / {formatBytes(data.quotaBytes)}</span>
					</div>
					<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
						<div
							class="h-full bg-foreground transition-all duration-300"
							style="width: {browserUsagePercent}%"
						></div>
					</div>
				{/if}
				<p class="mt-2 text-xs text-muted-foreground">
					Manage which songs are stored in the cloud and downloaded for offline playback.
				</p>
			</Card.Content>
		</Card.Root>
	</a>

	{#if data.session.isAdmin}
		<a href="/admin" class="mb-4 block">
			<Card.Root class="transition-colors hover:border-ring/50">
				<Card.Content class="flex items-center justify-between gap-3">
					<div class="flex items-center gap-2">
						<ShieldIcon class="size-4 text-muted-foreground" />
						<div>
							<p class="text-sm font-medium">Admin</p>
							<p class="text-xs text-muted-foreground">Invites, users, audit log, storage</p>
						</div>
					</div>
					<ChevronRightIcon class="size-4 shrink-0 text-muted-foreground" />
				</Card.Content>
			</Card.Root>
		</a>
	{/if}

	<Card.Root>
		<Card.Content>
			<p class="mb-3 truncate text-xs text-muted-foreground">{data.session.username}</p>
			<Button variant="outline" size="sm" class="w-full justify-start gap-2" onclick={handleLogout}>
				<LogOutIcon class="size-4" />
				Log out
			</Button>
		</Card.Content>
	</Card.Root>
</div>
