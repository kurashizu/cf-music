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
		<Tabs.List class="grid w-full grid-cols-3">
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
