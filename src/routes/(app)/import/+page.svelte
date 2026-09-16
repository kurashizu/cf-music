<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { flip } from 'svelte/animate';
	import { fade } from 'svelte/transition';
	import { toast } from 'svelte-sonner';
	import { motionParams } from '$lib/client/motion';
	import { importStore } from '$lib/client/import.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import LinkIcon from '@lucide/svelte/icons/link';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import SkipForwardIcon from '@lucide/svelte/icons/skip-forward';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let sourceUrl = $state('');
	let targetPlaylistId = $state<string | undefined>(undefined);
	let submitting = $state(false);

	const targetPlaylistLabel = $derived(
		data.playlists.find((p) => p.id === targetPlaylistId)?.name ?? 'Default (Imports)'
	);

	const jobs = $derived([...importStore.jobs.values()].reverse());

	onMount(() => {
		for (const job of data.importJobs) {
			importStore.setJobFromServer(job);
		}
		importStore.connect();
	});

	onDestroy(() => {
		importStore.disconnect();
	});

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (sourceUrl.trim().length === 0) return;

		submitting = true;
		try {
			const response = await fetch('/api/import', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					sourceUrl: sourceUrl.trim(),
					// bits-ui's Select normalizes "nothing selected" to '' rather
					// than leaving the bound value undefined, so an empty string
					// has to be treated the same as "no playlist" here too.
					targetPlaylistId: targetPlaylistId || undefined
				})
			});
			if (!response.ok) {
				toast.error('Failed to start import');
				return;
			}
			const { jobId } = (await response.json()) as { jobId: string };
			importStore.setJobFromServer({
				id: jobId,
				sourceUrl: sourceUrl.trim(),
				status: 'pending',
				totalCount: null,
				completedCount: 0,
				knownCount: 0,
				failedCount: 0,
				failures: null,
				previewEntries: null,
				fatalError: null
			});
			sourceUrl = '';
			toast.success('Import started');
		} catch {
			toast.error('Failed to start import');
		} finally {
			submitting = false;
		}
	}

</script>

<svelte:head>
	<title>Import · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-2xl p-4 md:p-8">
	<h1 class="mb-6 text-lg font-medium">Import</h1>

	<Card.Root class="mb-8">
		<Card.Content>
			<form class="flex flex-col gap-4" onsubmit={handleSubmit}>
				<div class="flex flex-col gap-2">
					<Label for="source-url">Link</Label>
					<div class="relative">
						<LinkIcon class="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							id="source-url"
							placeholder="https://youtube.com/watch?v=... or a playlist link"
							class="pl-8"
							required
							bind:value={sourceUrl}
						/>
					</div>
				</div>

				<div class="flex flex-col gap-2">
					<Label for="target-playlist">Add to playlist</Label>
					<Select.Root type="single" bind:value={targetPlaylistId}>
						<Select.Trigger id="target-playlist" class="w-full">
							{targetPlaylistLabel}
						</Select.Trigger>
						<Select.Content>
							{#each data.playlists as playlist (playlist.id)}
								<Select.Item value={playlist.id} label={playlist.name}>{playlist.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				<Button type="submit" class="gap-1.5" disabled={submitting}>
					{#if submitting}
						<LoaderCircleIcon class="size-4 animate-spin" />
						Starting…
					{:else}
						Import
					{/if}
				</Button>
			</form>
		</Card.Content>
	</Card.Root>

	{#if jobs.length > 0}
		<div class="flex flex-col gap-3">
			<h2 class="text-sm font-medium text-muted-foreground">Importing</h2>
			{#each jobs as job (job.jobId)}
				<div animate:flip={motionParams({ duration: 200 })} transition:fade={motionParams({ duration: 150 })}>
				<Card.Root>
					<Card.Content class="flex flex-col gap-3">
						<div class="flex items-center justify-between gap-3">
							<p class="min-w-0 truncate text-sm text-muted-foreground">{job.sourceUrl}</p>
							<span class="shrink-0 rounded-full px-2 py-0.5 text-xs text-muted-foreground">
								{job.status}
							</span>
						</div>

						{#key job.status === 'failed' ? 'failed' : job.probing ? 'probing' : 'progress'}
						<div transition:fade={motionParams({ duration: 120 })}>
						{#if job.status === 'failed'}
							<div class="flex items-start gap-3">
								<CircleXIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
								<p class="min-w-0 flex-1 text-sm text-destructive">
									{job.fatalError ?? 'Import failed'}
								</p>
								<Button size="sm" variant="ghost" onclick={() => importStore.cancel(job.jobId)}>
									Dismiss
								</Button>
							</div>
						{:else if job.probing}
							<div class="flex items-center gap-3">
								<LoaderCircleIcon class="size-4 shrink-0 animate-spin text-muted-foreground" />
								<div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
									<div
										class="h-full bg-foreground transition-all duration-300"
										style="width: {Math.min(100, (job.probing.checked / job.probing.total) * 100)}%"
									></div>
								</div>
								<span class="shrink-0 text-xs text-muted-foreground">
									Checking sizes {job.probing.checked} / {job.probing.total}
								</span>
								<Button size="sm" variant="ghost" onclick={() => importStore.cancel(job.jobId)}>
									Cancel
								</Button>
							</div>
						{:else}
							<div class="flex items-center gap-3">
								<LoaderCircleIcon class="size-4 shrink-0 animate-spin text-muted-foreground" />
								<div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
									<div
										class="h-full bg-foreground transition-all duration-300"
										style="width: {job.totalCount
											? Math.min(
													100,
													((job.completedCount + job.knownCount + job.failedCount) / job.totalCount) * 100
												)
											: 0}%"
									></div>
								</div>
								<span class="shrink-0 text-xs text-muted-foreground">
									{job.completedCount + job.knownCount + job.failedCount} / {job.totalCount ?? '?'}
								</span>
								<Button size="sm" variant="ghost" onclick={() => importStore.cancel(job.jobId)}>
									Cancel
								</Button>
							</div>
							{#if job.previewEntries || job.knownCount > 0}
								<div class="flex items-center gap-3 text-xs text-muted-foreground">
									{#if job.previewEntries}
										<div class="flex items-center gap-1.5">
											<ListChecksIcon class="size-4" />
											{job.previewEntries.length} {job.previewEntries.length === 1 ? 'song' : 'songs'} found
										</div>
									{/if}
									{#if job.knownCount > 0}
										<div class="flex items-center gap-1.5">
											<SkipForwardIcon class="size-4" />
											{job.knownCount} skipped (already in library)
										</div>
									{/if}
								</div>
							{/if}
						{/if}
						</div>
						{/key}
					</Card.Content>
				</Card.Root>
				</div>
			{/each}
		</div>
	{/if}
</div>
