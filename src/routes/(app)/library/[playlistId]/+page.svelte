<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { player } from '$lib/client/player.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import MusicIcon from '@lucide/svelte/icons/music';
	import { untrack } from 'svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Mirrors data.playlist.songs into local mutable state so drag-to-reorder
	// can preview the new order instantly, before the PUT /reorder request
	// resolves. Re-synced only when the *server* value changes reference
	// (playlist navigation, or invalidateAll() after a remove) — comparing
	// against the local `songs` state itself would snap a live drag back to
	// the server order the instant it diverges, so the sync check reads
	// data.playlist.songs (reactive) without also depending on `songs`.
	let songs = $state(untrack(() => data.playlist.songs));
	let lastServerSongs = untrack(() => data.playlist.songs);
	$effect(() => {
		if (data.playlist.songs !== lastServerSongs) {
			lastServerSongs = data.playlist.songs;
			songs = data.playlist.songs;
		}
	});

	// draggingIndex/overIndex describe the drag purely in terms of the
	// *original* indices in `songs`. The list below renders using this
	// pair to compute each row's visual `order` (CSS), instead of
	// splicing `songs` itself on every dragover — splicing would move the
	// keyed DOM node the browser is actively tracking mid-drag, which is
	// what caused focus/hover state to jump around during a drag.
	// `songs` is only actually reordered once, on drop.
	let draggingIndex = $state<number | null>(null);
	let overIndex = $state<number | null>(null);
	let removeTarget = $state<{ videoId: string; title: string } | null>(null);
	let removeSubmitting = $state(false);
	let deleteTarget = $state<{ videoId: string; title: string } | null>(null);
	let deleteSubmitting = $state(false);

	const isThisPlaylistPlaying = $derived(
		player.isPlaying && songs.some((s) => s.videoId === player.currentTrack?.videoId)
	);

	function toQueueTracks() {
		return songs.map((s) => ({
			videoId: s.videoId,
			title: s.title,
			durationSeconds: s.durationSeconds
		}));
	}

	function formatDuration(seconds: number | null): string {
		if (seconds === null) return '—';
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	function formatAudioSpec(codec: string, bitrateKbps: number | null): string {
		return bitrateKbps ? `${codec} · ${bitrateKbps}kbps` : codec;
	}

	async function playAll(shuffle = false) {
		if (songs.length === 0) return;
		await player.playQueue(toQueueTracks(), 0, shuffle);
	}

	async function playFrom(index: number) {
		await player.playQueue(toQueueTracks(), index);
	}

	async function handleRemove() {
		if (!removeTarget) return;
		removeSubmitting = true;
		try {
			const response = await fetch(
				`/api/playlists/${data.playlist.id}/songs/${removeTarget.videoId}`,
				{ method: 'DELETE' }
			);
			if (!response.ok) {
				toast.error('Failed to remove song');
				return;
			}
			toast.success('Removed from playlist');
			removeTarget = null;
			await invalidateAll();
		} catch {
			toast.error('Failed to remove song');
		} finally {
			removeSubmitting = false;
		}
	}

	// Distinct from handleRemove: this deletes the song itself (see
	// DELETE /api/songs/[videoId] — evictSongForUser), not just its
	// membership in this one playlist. It disappears from every playlist
	// it was in, and its storage is freed if no one else still references
	// it (songs are deduplicated/shared across users' libraries).
	async function handleDelete() {
		if (!deleteTarget) return;
		deleteSubmitting = true;
		try {
			const response = await fetch(`/api/songs/${deleteTarget.videoId}`, { method: 'DELETE' });
			if (!response.ok) {
				toast.error('Failed to delete song');
				return;
			}
			toast.success('Song deleted');
			deleteTarget = null;
			await invalidateAll();
		} catch {
			toast.error('Failed to delete song');
		} finally {
			deleteSubmitting = false;
		}
	}

	function handleDragStart(index: number) {
		draggingIndex = index;
		overIndex = index;
	}

	function handleDragOver(event: DragEvent, index: number) {
		event.preventDefault();
		if (draggingIndex === null) return;
		overIndex = index;
	}

	function visualOrder(index: number): number {
		if (draggingIndex === null || overIndex === null || draggingIndex === index) return index;
		if (draggingIndex < overIndex) {
			if (index > draggingIndex && index <= overIndex) return index - 1;
		} else if (index >= overIndex && index < draggingIndex) {
			return index + 1;
		}
		return index;
	}

	async function handleDragEnd() {
		if (draggingIndex !== null && overIndex !== null && draggingIndex !== overIndex) {
			const reordered = [...songs];
			const [moved] = reordered.splice(draggingIndex, 1);
			reordered.splice(overIndex, 0, moved);
			songs = reordered;
		}
		draggingIndex = null;
		overIndex = null;
		try {
			const response = await fetch(`/api/playlists/${data.playlist.id}/reorder`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ orderedVideoIds: songs.map((s) => s.videoId) })
			});
			if (!response.ok) {
				toast.error('Failed to save the new order');
				await invalidateAll();
			}
		} catch {
			toast.error('Failed to save the new order');
			await invalidateAll();
		}
	}
</script>

<svelte:head>
	<title>{data.playlist.name} · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-3xl p-4 md:p-8">
	<div class="mb-6 flex flex-wrap items-center justify-between gap-4">
		<div class="min-w-0">
			<h1 class="truncate text-lg font-medium">{data.playlist.name}</h1>
			<p class="text-sm text-muted-foreground">{songs.length} {songs.length === 1 ? 'song' : 'songs'}</p>
		</div>
		<div class="flex items-center gap-2">
			<Button size="sm" class="gap-1.5" disabled={songs.length === 0} onclick={() => playAll()}>
				{#if isThisPlaylistPlaying}
					<PauseIcon class="size-4" />
					Playing
				{:else}
					<PlayIcon class="size-4" />
					Play
				{/if}
			</Button>
			<Button
				size="sm"
				variant="outline"
				class="gap-1.5"
				disabled={songs.length === 0}
				onclick={() => playAll(true)}
			>
				<ShuffleIcon class="size-4" />
				Shuffle
			</Button>
		</div>
	</div>

	{#if songs.length === 0}
		<div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
			<ListMusicIcon class="size-8 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">This playlist is empty. Import some songs to get started.</p>
		</div>
	{:else}
		<ul class="flex flex-col">
			{#each songs as song, index (song.videoId)}
				<li
					class="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted {player
						.currentTrack?.videoId === song.videoId
						? 'bg-muted'
						: ''} {draggingIndex === index ? 'opacity-50' : ''}"
					style="order: {visualOrder(index)}"
					draggable="true"
					ondragstart={() => handleDragStart(index)}
					ondragover={(e) => handleDragOver(e, index)}
					ondragend={handleDragEnd}
				>
					<button
						type="button"
						class="cursor-grab touch-none text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
						aria-label="Drag to reorder"
					>
						<GripVerticalIcon class="size-4" />
					</button>

					<button
						type="button"
						class="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
						onclick={() => playFrom(index)}
						aria-label={player.currentTrack?.videoId === song.videoId && player.isPlaying
							? 'Pause'
							: 'Play'}
					>
						{#if player.currentTrack?.videoId === song.videoId && player.isPlaying}
							<PauseIcon class="size-4" />
						{:else}
							<PlayIcon class="size-4" />
						{/if}
					</button>

					<div class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
						{#if song.coverUrl}
							<img src={song.coverUrl} alt="" class="size-8 object-cover" />
						{:else}
							<MusicIcon class="size-3.5 text-muted-foreground" />
						{/if}
					</div>

					<div class="min-w-0 flex-1">
						<p
							class="truncate text-sm {player.currentTrack?.videoId === song.videoId
								? 'text-foreground'
								: 'text-foreground/90'}"
						>
							{song.title}
						</p>
					</div>

					<span
						class="hidden shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground sm:inline-block"
					>
						{formatAudioSpec(song.codec, song.bitrateKbps)}
					</span>

					<span class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
						<ClockIcon class="size-3" />
						{formatDuration(song.durationSeconds)}
					</span>

					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon-sm"
									class="opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
								>
									<MoreHorizontalIcon class="size-4" />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" class="min-w-52">
							<DropdownMenu.Item
								onclick={() => (removeTarget = { videoId: song.videoId, title: song.title })}
							>
								<ListMusicIcon class="size-4" />
								Remove from playlist
							</DropdownMenu.Item>
							<DropdownMenu.Item
								variant="destructive"
								onclick={() => (deleteTarget = { videoId: song.videoId, title: song.title })}
							>
								<Trash2Icon class="size-4" />
								Delete from library
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<Dialog.Root open={removeTarget !== null} onOpenChange={(open) => !open && (removeTarget = null)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Remove "{removeTarget?.title}"?</Dialog.Title>
			<Dialog.Description>This only removes it from this playlist.</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (removeTarget = null)}>Cancel</Button>
			<Button variant="destructive" disabled={removeSubmitting} onclick={handleRemove}>
				{removeSubmitting ? 'Removing…' : 'Remove'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete "{deleteTarget?.title}"?</Dialog.Title>
			<Dialog.Description>
				This deletes the song from your library entirely, not just this playlist — it disappears from
				every playlist it's in. This can't be undone.
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
