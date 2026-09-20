<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { isTouchDevice } from '$lib/client/motion';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import Logo from '$lib/components/logo.svelte';
	import PlayerBar from '$lib/components/player-bar.svelte';
	import BuildInfo from '$lib/components/build-info.svelte';
	import LibraryIcon from '@lucide/svelte/icons/library';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
	import PanelLeftOpenIcon from '@lucide/svelte/icons/panel-left-open';
	import { sidebar } from '$lib/client/sidebar.svelte';
	import { fade } from 'svelte/transition';
	import { motionParams } from '$lib/client/motion';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	// Settings lives at the bottom of the desktop sidebar, separate from
	// these — see the <aside> markup below. Mobile has no "bottom of
	// sidebar" area, so it stays in the same list there instead (see the
	// mobile bottom nav below, which renders navItems + settingsItem
	// together).
	const navItems = $derived([
		{ href: '/library', label: 'Library', icon: LibraryIcon },
		{ href: '/import', label: 'Import', icon: UploadIcon },
		{ href: '/stats', label: 'Stats', icon: ChartColumnIcon }
	]);
	const settingsItem = { href: '/settings', label: 'Settings', icon: SettingsIcon };

	function isActive(href: string): boolean {
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}

	// Expanded by default whenever a playlist is the active page, so
	// navigating there (e.g. from a link elsewhere) doesn't hide the
	// context of which playlist you're in — otherwise defaults open, like
	// YouTube's own sidebar "Library" section.
	let playlistsExpanded = $state(true);

	// Resolved after mount so SSR and the first client render agree (the
	// server can't know the pointer type); tooltips simply stay enabled for
	// the first frame, which no touch user can act on that fast anyway.
	let tooltipsDisabled = $state(false);
	onMount(() => {
		tooltipsDisabled = isTouchDevice();
	});
</script>

<Toaster />

<!-- Suppressed on touch devices: see isTouchDevice. Read once on mount
     rather than reactively, since a device doesn't change pointer type
     mid-session in any way worth re-rendering the whole app for. -->
<Tooltip.Provider disabled={tooltipsDisabled}>
<div class="flex h-svh bg-background">
	<!-- Desktop sidebar -->
	<aside
		class="hidden shrink-0 flex-col border-r border-border p-4 transition-[width] duration-150 md:flex {sidebar.collapsed
			? 'w-16'
			: 'w-56'}"
	>
		<div class="mb-6 flex items-center gap-2 px-2 {sidebar.collapsed ? 'justify-center px-0' : ''}">
			<Logo size={24} />
			{#if !sidebar.collapsed}
				<span class="truncate text-sm font-medium" transition:fade={motionParams({ duration: 100 })}
					>KRSZ Music</span
				>
			{/if}
		</div>

		<nav class="flex min-h-0 flex-1 flex-col gap-1" aria-label="Primary">
			{#each navItems as item (item.href)}
				{#if item.href === '/library'}
					<div class="flex items-center gap-0.5">
						{#if sidebar.collapsed}
							<Tooltip.Root>
								<Tooltip.Trigger>
									{#snippet child({ props })}
										<a
											{...props}
											href={item.href}
											class="flex flex-1 items-center justify-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted active:text-foreground {isActive(
												item.href
											)
												? 'bg-muted text-foreground'
												: ''}"
										>
											<item.icon class="size-4" />
										</a>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content side="right">{item.label}</Tooltip.Content>
							</Tooltip.Root>
						{:else}
							<a
								href={item.href}
								class="flex flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted active:text-foreground {isActive(
									item.href
								)
									? 'bg-muted text-foreground'
									: ''}"
							>
								<item.icon class="size-4" />
								{item.label}
							</a>
							{#if data.sidebarPlaylists.length > 0 || data.sidebarSmartPlaylists.length > 0}
								<button
									type="button"
									class="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted active:text-foreground"
									onclick={() => (playlistsExpanded = !playlistsExpanded)}
									aria-label={playlistsExpanded ? 'Collapse playlists' : 'Expand playlists'}
									aria-expanded={playlistsExpanded}
								>
									<ChevronDownIcon
										class="size-3.5 transition-transform {playlistsExpanded ? '' : '-rotate-90'}"
									/>
								</button>
							{/if}
						{/if}
					</div>
					{#if playlistsExpanded && !sidebar.collapsed}
						<div class="flex flex-col gap-0.5 pl-4">
							{#each data.sidebarSmartPlaylists as playlist (playlist.id)}
								<a
									href="/library/{playlist.id}"
									class="flex items-center gap-2 truncate rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted active:text-foreground {isActive(
										`/library/${playlist.id}`
									)
										? 'bg-muted text-foreground'
										: ''}"
								>
									<SparklesIcon class="size-3.5 shrink-0" />
									<span class="truncate">{playlist.name}</span>
								</a>
							{/each}
							{#each data.sidebarPlaylists as playlist (playlist.id)}
								<a
									href="/library/{playlist.id}"
									class="flex items-center gap-2 truncate rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted active:text-foreground {isActive(
										`/library/${playlist.id}`
									)
										? 'bg-muted text-foreground'
										: ''}"
								>
									<ListMusicIcon class="size-3.5 shrink-0" />
									<span class="truncate">{playlist.name}</span>
								</a>
							{/each}
						</div>
					{/if}
				{:else if sidebar.collapsed}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<a
									{...props}
									href={item.href}
									class="flex items-center justify-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted active:text-foreground {isActive(
										item.href
									)
										? 'bg-muted text-foreground'
										: ''}"
								>
									<item.icon class="size-4" />
								</a>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="right">{item.label}</Tooltip.Content>
					</Tooltip.Root>
				{:else}
					<a
						href={item.href}
						class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted active:text-foreground {isActive(
							item.href
						)
							? 'bg-muted text-foreground'
							: ''}"
					>
						<item.icon class="size-4" />
						{item.label}
					</a>
				{/if}
			{/each}
		</nav>

		<div class="flex flex-col gap-1 border-t border-border pt-2">
			{#if sidebar.collapsed}
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<a
								{...props}
								href={settingsItem.href}
								class="flex items-center justify-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted active:text-foreground {isActive(
									settingsItem.href
								)
									? 'bg-muted text-foreground'
									: ''}"
							>
								<settingsItem.icon class="size-4" />
							</a>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content side="right">{settingsItem.label}</Tooltip.Content>
				</Tooltip.Root>
			{:else}
				<a
					href={settingsItem.href}
					class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted active:text-foreground {isActive(
						settingsItem.href
					)
						? 'bg-muted text-foreground'
						: ''}"
				>
					<settingsItem.icon class="size-4" />
					{settingsItem.label}
				</a>
			{/if}

			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<button
							{...props}
							type="button"
							class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted active:text-foreground {sidebar.collapsed
								? 'justify-center'
								: ''}"
							onclick={() => sidebar.toggle()}
							aria-label={sidebar.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
						>
							{#if sidebar.collapsed}
								<PanelLeftOpenIcon class="size-4" />
							{:else}
								<PanelLeftCloseIcon class="size-4" />
								<span transition:fade={motionParams({ duration: 100 })}>Collapse</span>
							{/if}
						</button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content side="right">{sidebar.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</Tooltip.Content>
			</Tooltip.Root>

			{#if !sidebar.collapsed}
				<div transition:fade={motionParams({ duration: 100 })}>
					<BuildInfo />
				</div>
			{/if}
		</div>
	</aside>

	<div class="flex min-w-0 flex-1 flex-col">
		<!-- Mobile top bar -->
		<header class="flex items-center gap-2 border-b border-border p-3 md:hidden">
			<Logo size={22} />
			<span class="text-sm font-medium">KRSZ Music</span>
		</header>

		<main class="min-h-0 flex-1 overflow-y-auto pb-16 md:pb-0">
			{@render children()}
		</main>

		<PlayerBar />

		<!-- Mobile bottom nav -->
		<nav
			class="fixed inset-x-0 bottom-0 flex items-center justify-around border-t border-border bg-card/95 py-2 backdrop-blur-sm md:hidden"
			aria-label="Primary (mobile)"
		>
			{#each [...navItems, settingsItem] as item (item.href)}
				<a
					href={item.href}
					class="flex flex-col items-center gap-0.5 rounded-lg px-3 py-1 text-[11px] text-muted-foreground transition-all active:scale-90 active:text-foreground {isActive(
						item.href
					)
						? 'text-foreground'
						: ''}"
				>
					<item.icon class="size-5" />
					{item.label}
				</a>
			{/each}
		</nav>
	</div>
</div>
</Tooltip.Provider>
