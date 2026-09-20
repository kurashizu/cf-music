<script lang="ts">
	import { formatBytes, formatDateTime } from '$lib/shared/format';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import TicketIcon from '@lucide/svelte/icons/ticket';
	import UsersIcon from '@lucide/svelte/icons/users';
	import ClipboardListIcon from '@lucide/svelte/icons/clipboard-list';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Seeded once from the server load, then updated locally by the
	// generate/edit actions below — same pattern as the playlist detail and
	// cache pages (see those for why untrack, not $derived, is correct here).
	let inviteCodes = $state(untrack(() => data.inviteCodes));
	let generating = $state(false);

	let quotaTarget = $state<{ id: string; username: string; storageQuotaBytes: number } | null>(
		null
	);
	let quotaGb = $state('');
	let quotaSubmitting = $state(false);
	let users = $state(untrack(() => data.users));

	// Storage scans hit S3 directly (a full bucket listing) — unlike the
	// other tabs' data, not loaded eagerly on page load; run on demand via
	// the buttons below instead.
	interface OrphanScanResult {
		orphanKeys: string[];
		totalBucketKeys: number;
		totalReferencedKeys: number;
	}
	interface DeadReference {
		videoId: string;
		title: string;
		field: 'audioKey' | 'coverKey';
		key: string;
	}
	interface DeadReferenceScanResult {
		deadReferences: DeadReference[];
		totalBucketKeys: number;
		totalSongs: number;
	}
	interface UnreferencedSong {
		videoId: string;
		title: string;
	}
	interface UnreferencedSongScanResult {
		unreferencedSongs: UnreferencedSong[];
		totalSongs: number;
	}

	let orphanScan = $state<OrphanScanResult | null>(null);
	let orphanScanLoading = $state(false);
	let orphanDeleting = $state<string | null>(null);

	let deadReferenceScan = $state<DeadReferenceScanResult | null>(null);
	let deadReferenceScanLoading = $state(false);
	let deadReferenceResolving = $state<string | null>(null);

	let unreferencedScan = $state<UnreferencedSongScanResult | null>(null);
	let unreferencedScanLoading = $state(false);
	let unreferencedResolving = $state<string | null>(null);

	// Deleting an unreferenced song is just as irreversible as deleting one
	// for a dead audioKey — same confirm-before-destroy treatment.
	let deleteUnreferencedTarget = $state<UnreferencedSong | null>(null);
	// Deleting a song for a dead audioKey is irreversible and can affect
	// other users who share the song (see resolveDeadSongReference) —
	// unlike clearing a dead coverKey (the song still plays fine either
	// way), this needs the same confirm-before-destroy step every other
	// destructive action in this app gets (compare the playlist delete
	// dialog on the Library page).
	let deleteSongTarget = $state<DeadReference | null>(null);

	async function runOrphanScan() {
		orphanScanLoading = true;
		try {
			const response = await fetch('/api/admin/storage/orphans');
			if (!response.ok) {
				toast.error('Failed to scan for orphaned objects');
				return;
			}
			orphanScan = (await response.json()) as OrphanScanResult;
		} catch {
			toast.error('Failed to scan for orphaned objects');
		} finally {
			orphanScanLoading = false;
		}
	}

	async function deleteOrphan(key: string) {
		orphanDeleting = key;
		try {
			const response = await fetch('/api/admin/storage/orphans', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ keys: [key] })
			});
			if (!response.ok) {
				toast.error('Failed to delete orphaned object');
				return;
			}
			const { deletedKeys } = (await response.json()) as { deletedKeys: string[] };
			if (deletedKeys.includes(key) && orphanScan) {
				orphanScan = { ...orphanScan, orphanKeys: orphanScan.orphanKeys.filter((k) => k !== key) };
				toast.success('Orphaned object deleted');
			} else {
				toast.error('No longer orphaned — a real upload may have landed since the scan');
			}
		} catch {
			toast.error('Failed to delete orphaned object');
		} finally {
			orphanDeleting = null;
		}
	}

	async function runDeadReferenceScan() {
		deadReferenceScanLoading = true;
		try {
			const response = await fetch('/api/admin/storage/dead-references');
			if (!response.ok) {
				toast.error('Failed to scan for dead references');
				return;
			}
			deadReferenceScan = (await response.json()) as DeadReferenceScanResult;
		} catch {
			toast.error('Failed to scan for dead references');
		} finally {
			deadReferenceScanLoading = false;
		}
	}

	function deadReferenceKey(reference: DeadReference): string {
		return `${reference.videoId}:${reference.field}`;
	}

	async function resolveDeadReference(reference: DeadReference) {
		deadReferenceResolving = deadReferenceKey(reference);
		try {
			const response = await fetch('/api/admin/storage/dead-references', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ videoId: reference.videoId, field: reference.field })
			});
			if (!response.ok) {
				toast.error('Failed to resolve dead reference');
				return;
			}
			const { resolved } = (await response.json()) as { resolved: boolean };
			if (resolved && deadReferenceScan) {
				deadReferenceScan = {
					...deadReferenceScan,
					deadReferences: deadReferenceScan.deadReferences.filter(
						(r) => deadReferenceKey(r) !== deadReferenceKey(reference)
					)
				};
				toast.success(reference.field === 'audioKey' ? 'Song deleted' : 'Cover reference cleared');
			} else {
				toast.error('No longer a dead reference — it may have already been resolved');
			}
		} catch {
			toast.error('Failed to resolve dead reference');
		} finally {
			deadReferenceResolving = null;
		}
	}

	function handleResolveClick(reference: DeadReference) {
		if (reference.field === 'audioKey') {
			deleteSongTarget = reference;
			return;
		}
		resolveDeadReference(reference);
	}

	async function confirmDeleteSong() {
		if (!deleteSongTarget) return;
		const target = deleteSongTarget;
		deleteSongTarget = null;
		await resolveDeadReference(target);
	}

	async function runUnreferencedScan() {
		unreferencedScanLoading = true;
		try {
			const response = await fetch('/api/admin/storage/unreferenced-songs');
			if (!response.ok) {
				toast.error('Failed to scan for unreferenced songs');
				return;
			}
			unreferencedScan = (await response.json()) as UnreferencedSongScanResult;
		} catch {
			toast.error('Failed to scan for unreferenced songs');
		} finally {
			unreferencedScanLoading = false;
		}
	}

	async function resolveUnreferenced(song: UnreferencedSong) {
		unreferencedResolving = song.videoId;
		try {
			const response = await fetch('/api/admin/storage/unreferenced-songs', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ videoId: song.videoId })
			});
			if (!response.ok) {
				toast.error('Failed to delete unreferenced song');
				return;
			}
			const { resolved } = (await response.json()) as { resolved: boolean };
			if (resolved && unreferencedScan) {
				unreferencedScan = {
					...unreferencedScan,
					unreferencedSongs: unreferencedScan.unreferencedSongs.filter(
						(s) => s.videoId !== song.videoId
					)
				};
				toast.success('Song deleted');
			} else {
				toast.error('No longer unreferenced — it may have been added to a playlist since the scan');
			}
		} catch {
			toast.error('Failed to delete unreferenced song');
		} finally {
			unreferencedResolving = null;
		}
	}

	async function confirmDeleteUnreferenced() {
		if (!deleteUnreferencedTarget) return;
		const target = deleteUnreferencedTarget;
		deleteUnreferencedTarget = null;
		await resolveUnreferenced(target);
	}

	async function generateInviteCode() {
		generating = true;
		try {
			const response = await fetch('/api/admin/invite-codes', { method: 'POST' });
			if (!response.ok) {
				toast.error('Failed to generate invite code');
				return;
			}
			const { code } = (await response.json()) as { code: string };
			inviteCodes = [
				{ code, createdBy: '', createdAt: new Date().toISOString(), usedBy: null, usedAt: null },
				...inviteCodes
			];
			toast.success('Invite code created');
		} catch {
			toast.error('Failed to generate invite code');
		} finally {
			generating = false;
		}
	}

	async function copyCode(code: string) {
		try {
			await navigator.clipboard.writeText(code);
			toast.success('Copied to clipboard');
		} catch {
			toast.error('Failed to copy to clipboard');
		}
	}

	function openQuotaDialog(user: { id: string; username: string; storageQuotaBytes: number }) {
		quotaTarget = user;
		quotaGb = (user.storageQuotaBytes / (1024 * 1024 * 1024)).toFixed(2);
	}

	async function submitQuota() {
		if (!quotaTarget) return;
		const gb = Number(quotaGb);
		if (!Number.isFinite(gb) || gb <= 0) {
			toast.error('Enter a valid quota in GB');
			return;
		}

		quotaSubmitting = true;
		try {
			const quotaBytes = Math.round(gb * 1024 * 1024 * 1024);
			const response = await fetch(`/api/admin/users/${quotaTarget.id}/quota`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ quotaBytes })
			});
			if (!response.ok) {
				toast.error('Failed to update quota');
				return;
			}
			users = users.map((u) =>
				u.id === quotaTarget!.id ? { ...u, storageQuotaBytes: quotaBytes } : u
			);
			toast.success('Quota updated');
			quotaTarget = null;
		} catch {
			toast.error('Failed to update quota');
		} finally {
			quotaSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>Admin · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-4xl p-4 md:p-8">
	<h1 class="mb-6 text-lg font-medium">Admin</h1>

	<div class="mb-6 flex justify-end">
		<Button href="/admin/audit-log" variant="outline" size="sm" class="gap-1.5">
			<ClipboardListIcon class="size-4" />
			Audit log
		</Button>
	</div>

	<Tabs.Root value="invites" class="w-full">
		<Tabs.List class="grid w-full grid-cols-3">
			<Tabs.Trigger value="invites" class="gap-1.5">
				<TicketIcon class="size-4" />
				Invites
			</Tabs.Trigger>
			<Tabs.Trigger value="users" class="gap-1.5">
				<UsersIcon class="size-4" />
				Users
			</Tabs.Trigger>
			<Tabs.Trigger value="storage" class="gap-1.5">
				<HardDriveIcon class="size-4" />
				Storage
			</Tabs.Trigger>
		</Tabs.List>

		<Tabs.Content value="invites" class="pt-4">
			<div class="mb-4 flex justify-end">
				<Button size="sm" disabled={generating} onclick={generateInviteCode}>
					{generating ? 'Generating…' : 'New invite code'}
				</Button>
			</div>
			{#if inviteCodes.length === 0}
				<p class="text-muted-foreground py-8 text-center text-sm">No invite codes yet.</p>
			{:else}
				<ul class="flex flex-col gap-1">
					{#each inviteCodes as invite (invite.code)}
						<li
							class="hover:bg-muted flex items-center gap-3 rounded-lg px-2 py-2 transition-colors"
						>
							<code class="text-sm">{invite.code}</code>
							<span
								class="rounded-full px-2 py-0.5 text-xs {invite.usedBy
									? 'text-muted-foreground'
									: 'text-foreground'}"
							>
								{invite.usedBy ? 'Used' : 'Available'}
							</span>
							<span class="text-muted-foreground flex-1 truncate text-xs">
								{formatDateTime(invite.createdAt)}
							</span>
							<Button variant="ghost" size="icon-sm" onclick={() => copyCode(invite.code)}>
								<CopyIcon class="size-3.5" />
							</Button>
						</li>
					{/each}
				</ul>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="users" class="pt-4">
			<ul class="flex flex-col gap-1">
				{#each users as user (user.id)}
					<li class="hover:bg-muted flex items-center gap-3 rounded-lg px-2 py-2 transition-colors">
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm">
								{user.username}
								{#if user.isAdmin}
									<span class="text-muted-foreground ml-1 text-xs">admin</span>
								{/if}
							</p>
							<p class="text-muted-foreground text-xs">
								{formatBytes(user.storageQuotaBytes)} quota
							</p>
						</div>
						<Button variant="outline" size="sm" onclick={() => openQuotaDialog(user)}>
							Edit quota
						</Button>
					</li>
				{/each}
			</ul>
		</Tabs.Content>

		<Tabs.Content value="storage" class="pt-4">
			<div class="flex flex-col gap-8">
				<div>
					<div class="mb-3 flex items-center justify-between gap-3">
						<div>
							<p class="text-sm font-medium">Orphaned objects</p>
							<p class="text-muted-foreground text-xs">
								S3 objects with no corresponding song — safe to delete.
							</p>
						</div>
						<Button
							size="sm"
							variant="outline"
							disabled={orphanScanLoading}
							onclick={runOrphanScan}
						>
							{orphanScanLoading ? 'Scanning…' : 'Run scan'}
						</Button>
					</div>
					{#if orphanScan}
						<p class="text-muted-foreground mb-2 text-xs">
							{orphanScan.orphanKeys.length} orphaned of {orphanScan.totalBucketKeys} objects in the bucket
						</p>
						{#if orphanScan.orphanKeys.length === 0}
							<p class="text-muted-foreground py-6 text-center text-sm">
								No orphaned objects found.
							</p>
						{:else}
							<ul class="flex flex-col gap-1">
								{#each orphanScan.orphanKeys as key (key)}
									<li
										class="hover:bg-muted flex items-center gap-3 rounded-lg px-2 py-2 transition-colors"
									>
										<code class="min-w-0 flex-1 truncate text-xs">{key}</code>
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={orphanDeleting === key}
											onclick={() => deleteOrphan(key)}
										>
											<Trash2Icon class="text-destructive size-3.5" />
										</Button>
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				</div>

				<div>
					<div class="mb-3 flex items-center justify-between gap-3">
						<div>
							<p class="text-sm font-medium">Dead references</p>
							<p class="text-muted-foreground text-xs">
								Songs whose audio/cover object no longer exists — needs a decision per row.
							</p>
						</div>
						<Button
							size="sm"
							variant="outline"
							disabled={deadReferenceScanLoading}
							onclick={runDeadReferenceScan}
						>
							{deadReferenceScanLoading ? 'Scanning…' : 'Run scan'}
						</Button>
					</div>
					{#if deadReferenceScan}
						<p class="text-muted-foreground mb-2 text-xs">
							{deadReferenceScan.deadReferences.length} dead reference{deadReferenceScan
								.deadReferences.length === 1
								? ''
								: 's'} across {deadReferenceScan.totalSongs} songs
						</p>
						{#if deadReferenceScan.deadReferences.length === 0}
							<p class="text-muted-foreground py-6 text-center text-sm">
								No dead references found.
							</p>
						{:else}
							<ul class="flex flex-col gap-1">
								{#each deadReferenceScan.deadReferences as reference (deadReferenceKey(reference))}
									<li
										class="hover:bg-muted flex items-center gap-3 rounded-lg px-2 py-2 transition-colors"
									>
										<div class="min-w-0 flex-1">
											<p class="truncate text-sm">
												{reference.title}
												<span class="text-muted-foreground ml-1 text-xs">{reference.field}</span>
											</p>
											<code class="text-muted-foreground text-xs">{reference.key}</code>
										</div>
										<Button
											variant={reference.field === 'audioKey' ? 'destructive' : 'outline'}
											size="sm"
											disabled={deadReferenceResolving === deadReferenceKey(reference)}
											onclick={() => handleResolveClick(reference)}
										>
											{reference.field === 'audioKey' ? 'Delete song' : 'Clear cover'}
										</Button>
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				</div>

				<div>
					<div class="mb-3 flex items-center justify-between gap-3">
						<div>
							<p class="text-sm font-medium">Unreferenced songs</p>
							<p class="text-muted-foreground text-xs">
								Songs with no playlist reaching them at all — invisible everywhere, safe to delete.
							</p>
						</div>
						<Button
							size="sm"
							variant="outline"
							disabled={unreferencedScanLoading}
							onclick={runUnreferencedScan}
						>
							{unreferencedScanLoading ? 'Scanning…' : 'Run scan'}
						</Button>
					</div>
					{#if unreferencedScan}
						<p class="text-muted-foreground mb-2 text-xs">
							{unreferencedScan.unreferencedSongs.length} unreferenced of {unreferencedScan.totalSongs}
							songs
						</p>
						{#if unreferencedScan.unreferencedSongs.length === 0}
							<p class="text-muted-foreground py-6 text-center text-sm">
								No unreferenced songs found.
							</p>
						{:else}
							<ul class="flex flex-col gap-1">
								{#each unreferencedScan.unreferencedSongs as song (song.videoId)}
									<li
										class="hover:bg-muted flex items-center gap-3 rounded-lg px-2 py-2 transition-colors"
									>
										<p class="min-w-0 flex-1 truncate text-sm">{song.title}</p>
										<Button
											variant="destructive"
											size="sm"
											disabled={unreferencedResolving === song.videoId}
											onclick={() => (deleteUnreferencedTarget = song)}
										>
											Delete song
										</Button>
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				</div>
			</div>
		</Tabs.Content>
	</Tabs.Root>
</div>

<Dialog.Root open={quotaTarget !== null} onOpenChange={(open) => !open && (quotaTarget = null)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Edit quota for {quotaTarget?.username}</Dialog.Title>
		</Dialog.Header>
		<form
			class="flex flex-col gap-4"
			onsubmit={(event) => {
				event.preventDefault();
				submitQuota();
			}}
		>
			<div class="flex flex-col gap-2">
				<label for="quota-gb" class="text-sm font-medium">Quota (GB)</label>
				<Input id="quota-gb" type="number" step="0.1" min="0.1" required bind:value={quotaGb} />
			</div>
			<Dialog.Footer>
				<Button type="submit" disabled={quotaSubmitting}>
					{quotaSubmitting ? 'Saving…' : 'Save'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	open={deleteSongTarget !== null}
	onOpenChange={(open) => !open && (deleteSongTarget = null)}
>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete "{deleteSongTarget?.title}"?</Dialog.Title>
			<Dialog.Description>
				This song has no audio object left in storage, so it can't be played anyway — deleting
				removes it permanently, including from every user's playlists that reference it. This cannot
				be undone.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteSongTarget = null)}>Cancel</Button>
			<Button
				variant="destructive"
				disabled={deleteSongTarget !== null &&
					deadReferenceResolving === deadReferenceKey(deleteSongTarget)}
				onclick={confirmDeleteSong}
			>
				{deleteSongTarget !== null && deadReferenceResolving === deadReferenceKey(deleteSongTarget)
					? 'Deleting…'
					: 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	open={deleteUnreferencedTarget !== null}
	onOpenChange={(open) => !open && (deleteUnreferencedTarget = null)}
>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete "{deleteUnreferencedTarget?.title}"?</Dialog.Title>
			<Dialog.Description>
				This song isn't reachable from any playlist, so no one can see or play it anyway — deleting
				removes it and its storage permanently. This cannot be undone.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteUnreferencedTarget = null)}>Cancel</Button>
			<Button
				variant="destructive"
				disabled={deleteUnreferencedTarget !== null &&
					unreferencedResolving === deleteUnreferencedTarget.videoId}
				onclick={confirmDeleteUnreferenced}
			>
				{deleteUnreferencedTarget !== null &&
				unreferencedResolving === deleteUnreferencedTarget.videoId
					? 'Deleting…'
					: 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
