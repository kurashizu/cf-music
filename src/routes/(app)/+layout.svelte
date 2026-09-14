<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import Logo from '$lib/components/logo.svelte';
	import PlayerBar from '$lib/components/player-bar.svelte';
	import BuildInfo from '$lib/components/build-info.svelte';
	import { player } from '$lib/client/player.svelte';
	import LibraryIcon from '@lucide/svelte/icons/library';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	const navItems = $derived(
		[
			{ href: '/library', label: 'Library', icon: LibraryIcon },
			{ href: '/import', label: 'Import', icon: UploadIcon },
			{ href: '/settings', label: 'Settings', icon: SettingsIcon },
			data.session.isAdmin ? { href: '/admin', label: 'Admin', icon: ShieldIcon } : null
		].filter((item) => item !== null)
	);

	function isActive(href: string): boolean {
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}

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
</script>

<Toaster />

<div class="flex min-h-svh bg-background">
	<!-- Desktop sidebar -->
	<aside class="hidden w-56 shrink-0 flex-col border-r border-border p-4 md:flex">
		<div class="mb-6 flex items-center gap-2 px-2">
			<Logo size={24} />
			<span class="text-sm font-medium">KRSZ Music</span>
		</div>

		<nav class="flex flex-1 flex-col gap-1" aria-label="Primary">
			{#each navItems as item (item.href)}
				<a
					href={item.href}
					class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground {isActive(
						item.href
					)
						? 'bg-muted text-foreground'
						: ''}"
				>
					<item.icon class="size-4" />
					{item.label}
				</a>
			{/each}
		</nav>

		<div class="flex flex-col gap-2 border-t border-border pt-4">
			<p class="truncate px-2.5 text-xs text-muted-foreground">{data.session.username}</p>
			<Button variant="ghost" size="sm" class="justify-start gap-2" onclick={handleLogout}>
				<LogOutIcon class="size-4" />
				Log out
			</Button>
			<BuildInfo />
		</div>
	</aside>

	<div class="flex min-w-0 flex-1 flex-col">
		<!-- Mobile top bar -->
		<header class="flex items-center justify-between gap-2 border-b border-border p-3 md:hidden">
			<div class="flex items-center gap-2">
				<Logo size={22} />
				<span class="text-sm font-medium">KRSZ Music</span>
			</div>
			<Button variant="ghost" size="icon-sm" aria-label="Log out" onclick={handleLogout}>
				<LogOutIcon class="size-4" />
			</Button>
		</header>

		<main
			class="min-h-0 flex-1 overflow-y-auto {player.currentTrack
				? 'pb-32 md:pb-20'
				: 'pb-16 md:pb-0'}"
		>
			{@render children()}
		</main>

		<PlayerBar />

		<!-- Mobile bottom nav -->
		<nav
			class="fixed inset-x-0 bottom-0 flex items-center justify-around border-t border-border bg-card/95 py-2 backdrop-blur-sm md:hidden"
			aria-label="Primary (mobile)"
		>
			{#each navItems as item (item.href)}
				<a
					href={item.href}
					class="flex flex-col items-center gap-0.5 rounded-lg px-3 py-1 text-[11px] text-muted-foreground transition-colors {isActive(
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
