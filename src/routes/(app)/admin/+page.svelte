<script lang="ts">
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
		field: 'audioKey' | 'coverKey';
		key: string;
	}
	interface DeadReferenceScanResult {
		deadReferences: DeadReference[];
		totalBucketKeys: number;
		totalSongs: number;
	}

	let orphanScan = $state<OrphanScanResult | null>(null);
	let orphanScanLoading = $state(false);
	let orphanDeleting = $state<string | null>(null);

	let deadReferenceScan = $state<DeadReferenceScanResult | null>(null);
	let deadReferenceScanLoading = $state(false);
	let deadReferenceResolving = $state<string | null>(null);

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
				toast.success(
					reference.field === 'audioKey' ? 'Song deleted' : 'Cover reference cleared'
				);
			} else {
				toast.error('No longer a dead reference — it may have already been resolved');
			}
		} catch {
			toast.error('Failed to resolve dead reference');
		} finally {
			deadReferenceResolving = null;
		}
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
			users = users.map((u) => (u.id === quotaTarget!.id ? { ...u, storageQuotaBytes: quotaBytes } : u));
			toast.success('Quota updated');
			quotaTarget = null;
		} catch {
			toast.error('Failed to update quota');
		} finally {
			quotaSubmitting = false;
		}
	}

	function formatBytes(bytes: number): string {
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString();
	}
</script>

<svelte:head>
	<title>Admin · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-4xl p-4 md:p-8">
	<h1 class="mb-6 text-lg font-medium">Admin</h1>

	<Tabs.Root value="invites" class="w-full">
		<Tabs.List class="grid w-full grid-cols-4">
			<Tabs.Trigger value="invites" class="gap-1.5">
				<TicketIcon class="size-4" />
				Invites
			</Tabs.Trigger>
			<Tabs.Trigger value="users" class="gap-1.5">
				<UsersIcon class="size-4" />
				Users
			</Tabs.Trigger>
			<Tabs.Trigger value="audit" class="gap-1.5">
				<ClipboardListIcon class="size-4" />
				Audit log
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
				<p class="py-8 text-center text-sm text-muted-foreground">No invite codes yet.</p>
			{:else}
				<ul class="flex flex-col gap-1">
					{#each inviteCodes as invite (invite.code)}
						<li class="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted">
							<code class="text-sm">{invite.code}</code>
							<span
								class="rounded-full px-2 py-0.5 text-xs {invite.usedBy
									? 'text-muted-foreground'
									: 'text-foreground'}"
							>
								{invite.usedBy ? 'Used' : 'Available'}
							</span>
							<span class="flex-1 truncate text-xs text-muted-foreground">
								{formatDate(invite.createdAt)}
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
					<li class="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted">
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm">
								{user.username}
								{#if user.isAdmin}
									<span class="ml-1 text-xs text-muted-foreground">admin</span>
								{/if}
							</p>
							<p class="text-xs text-muted-foreground">{formatBytes(user.storageQuotaBytes)} quota</p>
						</div>
						<Button variant="outline" size="sm" onclick={() => openQuotaDialog(user)}>
							Edit quota
						</Button>
					</li>
				{/each}
			</ul>
		</Tabs.Content>

		<Tabs.Content value="audit" class="pt-4">
			{#if data.auditEntries.length === 0}
				<p class="py-8 text-center text-sm text-muted-foreground">No audit events yet.</p>
			{:else}
				<ul class="flex flex-col gap-1">
					{#each data.auditEntries as entry (entry.id)}
						<li class="flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-muted">
							<span class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">
								{entry.eventType}
							</span>
							<span class="min-w-0 flex-1 truncate text-muted-foreground">
								{entry.targetType ? `${entry.targetType} ${entry.targetId}` : ''}
							</span>
							<span class="shrink-0 text-xs text-muted-foreground">{formatDate(entry.createdAt)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="storage" class="pt-4">
			<div class="flex flex-col gap-8">
				<div>
					<div class="mb-3 flex items-center justify-between gap-3">
						<div>
							<p class="text-sm font-medium">Orphaned objects</p>
							<p class="text-xs text-muted-foreground">
								S3 objects with no corresponding song — safe to delete.
							</p>
						</div>
						<Button size="sm" variant="outline" disabled={orphanScanLoading} onclick={runOrphanScan}>
							{orphanScanLoading ? 'Scanning…' : 'Run scan'}
						</Button>
					</div>
					{#if orphanScan}
						<p class="mb-2 text-xs text-muted-foreground">
							{orphanScan.orphanKeys.length} orphaned of {orphanScan.totalBucketKeys} objects in the bucket
						</p>
						{#if orphanScan.orphanKeys.length === 0}
							<p class="py-6 text-center text-sm text-muted-foreground">No orphaned objects found.</p>
						{:else}
							<ul class="flex flex-col gap-1">
								{#each orphanScan.orphanKeys as key (key)}
									<li class="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted">
										<code class="min-w-0 flex-1 truncate text-xs">{key}</code>
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={orphanDeleting === key}
											onclick={() => deleteOrphan(key)}
										>
											<Trash2Icon class="size-3.5 text-destructive" />
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
							<p class="text-xs text-muted-foreground">
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
						<p class="mb-2 text-xs text-muted-foreground">
							{deadReferenceScan.deadReferences.length} dead reference{deadReferenceScan.deadReferences
								.length === 1
								? ''
								: 's'} across {deadReferenceScan.totalSongs} songs
						</p>
						{#if deadReferenceScan.deadReferences.length === 0}
							<p class="py-6 text-center text-sm text-muted-foreground">No dead references found.</p>
						{:else}
							<ul class="flex flex-col gap-1">
								{#each deadReferenceScan.deadReferences as reference (deadReferenceKey(reference))}
									<li class="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted">
										<div class="min-w-0 flex-1">
											<p class="truncate text-sm">
												{reference.videoId}
												<span class="ml-1 text-xs text-muted-foreground">{reference.field}</span>
											</p>
											<code class="text-xs text-muted-foreground">{reference.key}</code>
										</div>
										<Button
											variant="outline"
											size="sm"
											disabled={deadReferenceResolving === deadReferenceKey(reference)}
											onclick={() => resolveDeadReference(reference)}
										>
											{reference.field === 'audioKey' ? 'Delete song' : 'Clear cover'}
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
