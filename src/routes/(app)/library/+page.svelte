<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import MoreVerticalIcon from '@lucide/svelte/icons/more-vertical';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let createOpen = $state(false);
	let createName = $state('');
	let createSubmitting = $state(false);

	let renameTarget = $state<{ id: string; name: string } | null>(null);
	let renameValue = $state('');
	let renameSubmitting = $state(false);

	let deleteTarget = $state<{ id: string; name: string } | null>(null);
	let deleteSubmitting = $state(false);

	async function handleCreate(event: SubmitEvent) {
		event.preventDefault();
		if (createName.trim().length === 0) return;
		createSubmitting = true;
		try {
			const response = await fetch('/api/playlists', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: createName.trim() })
			});
			if (!response.ok) {
				toast.error('Failed to create playlist');
				return;
			}
			toast.success('Playlist created');
			createOpen = false;
			createName = '';
			await invalidateAll();
		} finally {
			createSubmitting = false;
		}
	}

	function openRename(playlist: { id: string; name: string }) {
		renameTarget = playlist;
		renameValue = playlist.name;
	}

	async function handleRename(event: SubmitEvent) {
		event.preventDefault();
		if (!renameTarget || renameValue.trim().length === 0) return;
		renameSubmitting = true;
		try {
			const response = await fetch(`/api/playlists/${renameTarget.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: renameValue.trim() })
			});
			if (!response.ok) {
				toast.error('Failed to rename playlist');
				return;
			}
			toast.success('Playlist renamed');
			renameTarget = null;
			await invalidateAll();
		} finally {
			renameSubmitting = false;
		}
	}

	async function handleDelete() {
		if (!deleteTarget) return;
		deleteSubmitting = true;
		try {
			const response = await fetch(`/api/playlists/${deleteTarget.id}`, { method: 'DELETE' });
			if (!response.ok) {
				toast.error('Failed to delete playlist');
				return;
			}
			toast.success('Playlist deleted');
			deleteTarget = null;
			await invalidateAll();
		} finally {
			deleteSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>Library · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-5xl p-4 md:p-8">
	<div class="mb-6 flex items-center justify-between gap-4">
		<h1 class="text-lg font-medium">Your playlists</h1>
		<Dialog.Root bind:open={createOpen}>
			<Dialog.Trigger>
				{#snippet child({ props })}
					<Button {...props} size="sm" class="gap-1.5">
						<PlusIcon class="size-4" />
						New playlist
					</Button>
				{/snippet}
			</Dialog.Trigger>
			<Dialog.Content class="sm:max-w-sm">
				<Dialog.Header>
					<Dialog.Title>New playlist</Dialog.Title>
					<Dialog.Description>Give your playlist a name.</Dialog.Description>
				</Dialog.Header>
				<form class="flex flex-col gap-4" onsubmit={handleCreate}>
					<div class="flex flex-col gap-2">
						<Label for="new-playlist-name">Name</Label>
						<Input id="new-playlist-name" required bind:value={createName} />
					</div>
					<Dialog.Footer>
						<Button type="submit" disabled={createSubmitting}>
							{createSubmitting ? 'Creating…' : 'Create'}
						</Button>
					</Dialog.Footer>
				</form>
			</Dialog.Content>
		</Dialog.Root>
	</div>

	{#if data.playlists.length === 0}
		<div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
			<ListMusicIcon class="size-8 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">No playlists yet. Create one, or import from a link.</p>
			<Button size="sm" variant="outline" onclick={() => (createOpen = true)}>New playlist</Button>
		</div>
	{:else}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
			{#each data.playlists as playlist (playlist.id)}
				<Card.Root
					class="group relative overflow-hidden py-0 transition-colors hover:border-ring/50"
				>
					<a href="/library/{playlist.id}" class="flex flex-col gap-3 p-4">
						<div
							class="flex aspect-square items-center justify-center rounded-lg bg-muted transition-transform duration-200 group-hover:scale-[1.02]"
						>
							<ListMusicIcon class="size-8 text-muted-foreground" />
						</div>
						<div class="min-w-0">
							<p class="truncate text-sm font-medium">{playlist.name}</p>
						</div>
					</a>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon-sm"
									class="absolute top-2 right-2 bg-card/80 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
								>
									<MoreVerticalIcon class="size-4" />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end">
							<DropdownMenu.Item onclick={() => openRename(playlist)}>
								<PencilIcon class="size-4" />
								Rename
							</DropdownMenu.Item>
							<DropdownMenu.Item
								variant="destructive"
								onclick={() => (deleteTarget = playlist)}
							>
								<Trash2Icon class="size-4" />
								Delete
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>

<Dialog.Root open={renameTarget !== null} onOpenChange={(open) => !open && (renameTarget = null)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Rename playlist</Dialog.Title>
		</Dialog.Header>
		<form class="flex flex-col gap-4" onsubmit={handleRename}>
			<div class="flex flex-col gap-2">
				<Label for="rename-playlist-name">Name</Label>
				<Input id="rename-playlist-name" required bind:value={renameValue} />
			</div>
			<Dialog.Footer>
				<Button type="submit" disabled={renameSubmitting}>
					{renameSubmitting ? 'Saving…' : 'Save'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete "{deleteTarget?.name}"?</Dialog.Title>
			<Dialog.Description>
				This removes the playlist. Songs only referenced by this playlist may also be freed from your
				storage quota.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteSubmitting} onclick={handleDelete}>
				{deleteSubmitting ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
