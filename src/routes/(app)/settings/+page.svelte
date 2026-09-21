<script lang="ts">
	import { formatBytes } from '$lib/shared/format';
	import * as Select from '$lib/components/ui/select/index.js';
	import HardDriveDownloadIcon from '@lucide/svelte/icons/hard-drive-download';
	import { cacheSettings, CACHE_LIMIT_OPTIONS } from '$lib/client/cache-settings.svelte';
	import { apiErrorMessage } from '$lib/client/api-error';
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { silenceTrim } from '$lib/client/silence-trim.svelte';
	import {
		estimateBrowserStorage,
		storeRouteData,
		readRouteData,
		type StorageEstimate
	} from '$lib/client/offline-cache';
	import {
		summarizeLocalData,
		clearAllLocalData,
		type LocalDataSummary
	} from '$lib/client/local-storage-inventory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	interface AccountUsage {
		quotaBytes: number;
		usageBytes: number;
		session: { username: string; isAdmin: boolean };
	}

	// Fetched here rather than loaded server-side so this page opens with no
	// connection: skip silence, clearing local data and the cache figures all
	// work offline, and none of them should be unreachable because one cloud
	// total needs the server. The last known figures are kept so they show
	// something truthful rather than nothing, marked as out of date.
	let account = $state<AccountUsage | null>(null);
	let accountStale = $state(false);

	let browserStorage = $state<StorageEstimate | null>(null);
	let localData = $state<LocalDataSummary | null>(null);
	let clearConfirmOpen = $state(false);
	let clearing = $state(false);

	async function refreshLocalData() {
		localData = await summarizeLocalData();
	}

	async function handleClearLocalData() {
		clearing = true;
		try {
			await clearAllLocalData();
			toast.success('Local data cleared');
			clearConfirmOpen = false;
			// Preferences (view mode, sidebar, volume) and the queue just got
			// wiped along with everything else — reloading is the simplest
			// way to get every part of the UI reading fresh defaults instead
			// of whatever it already had in memory from before the clear.
			window.location.reload();
		} catch {
			toast.error('Failed to clear local data');
		} finally {
			clearing = false;
		}
	}

	async function handleLogout() {
		try {
			const response = await fetch('/api/auth/logout', { method: 'POST' });
			if (!response.ok) {
				toast.error(await apiErrorMessage(response, 'Failed to log out'));
				return;
			}
			await invalidateAll();
			await goto('/');
		} catch {
			toast.error('Failed to log out');
		}
	}

	const usagePercent = $derived(
		account && account.quotaBytes > 0
			? Math.min(100, (account.usageBytes / account.quotaBytes) * 100)
			: 0
	);
	const cacheLimitLabel = $derived(
		CACHE_LIMIT_OPTIONS.find((o) => o.bytes === cacheSettings.limitBytes)?.label ?? 'No limit'
	);

	const browserUsagePercent = $derived(
		browserStorage && account && account.quotaBytes > 0
			? Math.min(100, (browserStorage.usageBytes / account.quotaBytes) * 100)
			: 0
	);

	async function loadAccountUsage() {
		try {
			const response = await fetch('/api/account-usage');
			if (!response.ok) throw new Error(String(response.status));
			const fresh: AccountUsage = await response.json();
			account = fresh;
			accountStale = false;
			void storeRouteData('account-usage', fresh);
			return;
		} catch {
			// Offline, or the request failed — fall through to the last copy.
		}
		const cached = await readRouteData<AccountUsage>('account-usage');
		if (cached) {
			account = cached.data;
			accountStale = true;
		}
	}

	onMount(() => {
		estimateBrowserStorage().then((estimate) => {
			browserStorage = estimate;
		});
		refreshLocalData();
		void loadAccountUsage();
	});
</script>

<svelte:head>
	<title>Settings · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-2xl p-4 md:p-8">
	<h1 class="mb-6 text-lg font-medium">Settings</h1>

	<a href="/settings/storage" class="mb-4 block">
		<Card.Root class="hover:border-ring/50 transition-colors">
			<Card.Content>
				<div class="mb-2 flex items-center justify-between text-sm">
					<span class="text-muted-foreground flex items-center gap-1.5">
						<HardDriveIcon class="size-4" />
						Manage storage
					</span>
					<div class="text-muted-foreground flex items-center gap-1.5">
						{#if account}
							<span>
								{formatBytes(account.usageBytes)} / {formatBytes(account.quotaBytes)} cloud
							</span>
						{:else}
							<span>Offline</span>
						{/if}
						<ChevronRightIcon class="size-4 shrink-0" />
					</div>
				</div>
				{#if account}
					<div class="bg-muted h-1.5 overflow-hidden rounded-full">
						<div
							class="bg-foreground h-full transition-all duration-300"
							style="width: {usagePercent}%"
						></div>
					</div>
					{#if accountStale}
						<p class="text-muted-foreground mt-1 text-[11px]">
							Cloud figures from the last time you were online.
						</p>
					{/if}
				{/if}
				{#if browserStorage}
					<div class="text-muted-foreground mt-2 flex items-center justify-between text-xs">
						<span class="flex items-center gap-1.5">
							<GlobeIcon class="size-3.5" />
							Offline cache
						</span>
						<span>
							{formatBytes(browserStorage.usageBytes)}{account
								? ` / ${formatBytes(account.quotaBytes)}`
								: ''}
						</span>
					</div>
					<div class="bg-muted mt-1 h-1.5 overflow-hidden rounded-full">
						<div
							class="bg-foreground h-full transition-all duration-300"
							style="width: {browserUsagePercent}%"
						></div>
					</div>
				{/if}
				<p class="text-muted-foreground mt-2 text-xs">
					Manage which songs are stored in the cloud and downloaded for offline playback.
				</p>
			</Card.Content>
		</Card.Root>
	</a>

	{#if account?.session.isAdmin}
		<a href="/admin" class="mb-4 block">
			<Card.Root class="hover:border-ring/50 transition-colors">
				<Card.Content class="flex items-center justify-between gap-3">
					<div class="flex items-center gap-2">
						<ShieldIcon class="text-muted-foreground size-4" />
						<div>
							<p class="text-sm font-medium">Admin</p>
							<p class="text-muted-foreground text-xs">Invites, users, audit log, storage</p>
						</div>
					</div>
					<ChevronRightIcon class="text-muted-foreground size-4 shrink-0" />
				</Card.Content>
			</Card.Root>
		</a>
	{/if}

	<Card.Root class="mb-4">
		<Card.Content>
			<div class="text-muted-foreground mb-2 flex items-center gap-1.5 text-sm">
				<AudioLinesIcon class="size-4" />
				Playback
			</div>
			<Label class="flex cursor-pointer items-start justify-between gap-3 font-normal">
				<span class="min-w-0">
					<span class="block text-sm">Skip silence</span>
					<span class="text-muted-foreground block text-xs font-normal">
						Start past a track's silent intro and move on at its silent tail. Each track is measured
						once after you've played it, so trimming applies from its next play. This device only;
						your files aren't changed.
					</span>
				</span>
				<Switch
					class="mt-0.5"
					checked={silenceTrim.enabled}
					onCheckedChange={(checked) => silenceTrim.set(checked)}
				/>
			</Label>
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-4">
		<Card.Content>
			<div class="text-muted-foreground mb-2 flex items-center gap-1.5 text-sm">
				<HardDriveDownloadIcon class="size-4" />
				Offline cache
			</div>
			<Label class="flex cursor-pointer items-start justify-between gap-3 font-normal">
				<span class="min-w-0">
					<span class="block text-sm">Auto cache played songs</span>
					<span class="text-muted-foreground block text-xs font-normal">
						Keep a song on this device once you've played it through, so it works offline. Turning
						this off stops keeping new songs; it doesn't remove what's already here.
					</span>
				</span>
				<Switch
					class="mt-0.5"
					checked={cacheSettings.autoCache}
					onCheckedChange={(checked) => cacheSettings.setAutoCache(checked)}
				/>
			</Label>

			<div class="mt-4 flex items-start justify-between gap-3">
				<span class="min-w-0">
					<span class="block text-sm">Cache limit</span>
					<span class="text-muted-foreground block text-xs font-normal">
						When auto-cached songs exceed this, the ones you play least and least recently are
						removed first. Songs you downloaded yourself are never removed automatically.
					</span>
				</span>
				<Select.Root
					type="single"
					value={String(cacheSettings.limitBytes ?? 'none')}
					onValueChange={(value) =>
						cacheSettings.setLimitBytes(value === 'none' ? null : Number(value))}
				>
					<Select.Trigger class="mt-0.5 w-32 shrink-0">{cacheLimitLabel}</Select.Trigger>
					<Select.Content>
						{#each CACHE_LIMIT_OPTIONS as option (option.label)}
							<Select.Item value={String(option.bytes ?? 'none')} label={option.label}>
								{option.label}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-4">
		<Card.Content>
			<div class="text-muted-foreground mb-2 flex items-center gap-1.5 text-sm">
				<DatabaseIcon class="size-4" />
				Local data
			</div>
			<p class="text-muted-foreground mb-3 text-xs">
				Preferences (view mode, volume, sidebar), your saved playback position, and cached
				thumbnails/audio all live in this browser only.
				{#if localData}
					Currently: {formatBytes(localData.localStorageBytes)} of preferences, {localData.cacheEntryCount}
					cached {localData.cacheEntryCount === 1 ? 'file' : 'files'}.
				{/if}
			</p>
			<Button
				variant="outline"
				size="sm"
				class="w-full justify-start gap-2"
				onclick={() => (clearConfirmOpen = true)}
			>
				<DatabaseIcon class="size-4" />
				Clear local data
			</Button>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Content>
			{#if account}
				<p class="text-muted-foreground mb-3 truncate text-xs">{account.session.username}</p>
			{/if}
			<Button variant="outline" size="sm" class="w-full justify-start gap-2" onclick={handleLogout}>
				<LogOutIcon class="size-4" />
				Log out
			</Button>
		</Card.Content>
	</Card.Root>
</div>

<Dialog.Root bind:open={clearConfirmOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Clear local data?</Dialog.Title>
			<Dialog.Description>
				Removes your saved preferences, playback position, and every cached thumbnail/audio file
				from this browser. Your library and playlists in the cloud are unaffected — this only clears
				what's stored locally.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (clearConfirmOpen = false)}>Cancel</Button>
			<Button variant="destructive" disabled={clearing} onclick={handleClearLocalData}>
				{clearing ? 'Clearing…' : 'Clear local data'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
