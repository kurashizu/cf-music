<script lang="ts">
	import { formatDateTime } from '$lib/shared/format';
	import SearchField from '$lib/components/search-field.svelte';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import XIcon from '@lucide/svelte/icons/x';
	import { AUDIT_EVENT_TYPES } from '$lib/shared/audit-event-types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Seeded once from the server load, then updated locally by the filter
	// inputs below — same pattern as the main admin page's invite codes
	// (see that page for why untrack, not $derived, is correct here).
	let searchInput = $state(untrack(() => data.search));
	let fromDateInput = $state(untrack(() => data.fromDate));
	let toDateInput = $state(untrack(() => data.toDate));
	let selectedEventTypes = $state<string[]>(untrack(() => data.eventTypes));
	let detailEntry = $state<(typeof data.entries)[number] | null>(null);

	const EVENT_TYPE_LABELS: Record<string, string> = {
		import: 'Import',
		evict: 'Evict',
		manual_delete: 'Manual delete',
		cover_reference_cleared: 'Cover reference cleared',
		login: 'Login',
		login_failed: 'Login failed',
		password_change: 'Password change',
		invite_used: 'Invite used',
		invite_created: 'Invite created',
		quota_adjusted: 'Quota adjusted',
		force_logout: 'Force logout',
		embedding_claimed: 'Embedding claimed',
		embedding_completed: 'Embedding completed',
		embedding_failed: 'Embedding failed'
	};

	function eventTypeBadgeClass(eventType: string): string {
		if (eventType.endsWith('_failed') || eventType === 'manual_delete' || eventType === 'evict') {
			return 'bg-destructive/15 text-destructive';
		}
		if (eventType === 'embedding_completed' || eventType === 'import' || eventType === 'login') {
			return 'bg-primary/15 text-primary';
		}
		return 'bg-muted text-muted-foreground';
	}

	function actorLabel(entry: (typeof data.entries)[number]): string {
		if (entry.actorUsername && entry.actorUsername !== entry.username) {
			return `${entry.actorUsername} (acting on ${entry.username ?? entry.userId ?? 'unknown'})`;
		}
		return entry.username ?? entry.actorUsername ?? 'System';
	}

	function targetLabel(entry: (typeof data.entries)[number]): string {
		if (!entry.targetType) return '—';
		if (entry.targetType === 'user') return entry.targetUsername ?? entry.targetId ?? '—';
		return `${entry.targetType} ${entry.targetId ?? ''}`.trim();
	}

	/** One-line, human summary built from whatever detail fields this event type actually has — falls back to nothing extra for event types with no detail worth surfacing inline (full JSON is always in the detail dialog). */
	function detailSummary(entry: (typeof data.entries)[number]): string {
		if (!entry.detail) return '';
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(entry.detail);
		} catch {
			return '';
		}

		switch (entry.eventType) {
			case 'embedding_claimed': {
				const videoIds = parsed.videoIds;
				return Array.isArray(videoIds) ? `${videoIds.length} job(s) claimed` : '';
			}
			case 'embedding_completed': {
				const parts = [];
				if (typeof parsed.dimensions === 'number') parts.push(`${parsed.dimensions}d`);
				if (typeof parsed.segmentCount === 'number')
					parts.push(`${parsed.segmentCount} segment(s)`);
				if (typeof parsed.totalAudioSeconds === 'number')
					parts.push(`${parsed.totalAudioSeconds.toFixed(0)}s audio`);
				if (typeof parsed.embedMillis === 'number') parts.push(`${parsed.embedMillis}ms`);
				return parts.join(' · ');
			}
			case 'embedding_failed':
				return typeof parsed.error === 'string' ? parsed.error : '';
			case 'import':
				return typeof parsed.sourceUrl === 'string' ? parsed.sourceUrl : '';
			case 'quota_adjusted':
				return typeof parsed.newQuotaBytes === 'number'
					? `new quota: ${(parsed.newQuotaBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
					: '';
			default:
				return '';
		}
	}

	function prettyDetail(detail: string | null): string {
		if (!detail) return '';
		try {
			return JSON.stringify(JSON.parse(detail), null, 2);
		} catch {
			return detail;
		}
	}

	function applyFilters() {
		const params = new URLSearchParams();
		if (searchInput.trim()) params.set('search', searchInput.trim());
		if (selectedEventTypes.length > 0) params.set('eventTypes', selectedEventTypes.join(','));
		if (fromDateInput) params.set('from', fromDateInput);
		if (toDateInput) params.set('to', toDateInput);
		goto(`?${params.toString()}`, { keepFocus: true });
	}

	// Debounced so typing in the search box doesn't fire a server round
	// trip per keystroke — the other filters (event type, dates) apply
	// immediately on change instead, since those are discrete selections
	// rather than continuous typing.
	let searchDebounceHandle: ReturnType<typeof setTimeout> | undefined;
	function onSearchInput() {
		clearTimeout(searchDebounceHandle);
		searchDebounceHandle = setTimeout(applyFilters, 300);
	}

	function clearFilters() {
		searchInput = '';
		fromDateInput = '';
		toDateInput = '';
		selectedEventTypes = [];
		goto('?');
	}

	function goToPage(targetPage: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('page', String(targetPage));
		goto(`?${params.toString()}`);
	}

	const totalPages = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));
	const hasActiveFilters = $derived(
		data.search !== '' || data.eventTypes.length > 0 || data.fromDate !== '' || data.toDate !== ''
	);
</script>

<svelte:head>
	<title>Audit log · Admin · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-5xl p-4 md:p-8">
	<div class="mb-6 flex items-center gap-3">
		<Button href="/admin" variant="ghost" size="icon-sm">
			<ArrowLeftIcon class="size-4" />
		</Button>
		<h1 class="text-lg font-medium">Audit log</h1>
		<span class="text-muted-foreground text-sm">{data.total} events</span>
	</div>

	<div class="mb-4 flex flex-wrap items-center gap-2">
		<SearchField
			bind:value={searchInput}
			placeholder="Search username, target, error, IP…"
			oninput={onSearchInput}
		/>

		<Select.Root type="multiple" bind:value={selectedEventTypes} onValueChange={applyFilters}>
			<Select.Trigger class="w-44">
				{selectedEventTypes.length === 0
					? 'All event types'
					: `${selectedEventTypes.length} type(s)`}
			</Select.Trigger>
			<Select.Content>
				{#each AUDIT_EVENT_TYPES as eventType (eventType)}
					<Select.Item value={eventType} label={EVENT_TYPE_LABELS[eventType]}>
						{EVENT_TYPE_LABELS[eventType]}
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>

		<Input type="date" bind:value={fromDateInput} onchange={applyFilters} class="w-36" />
		<span class="text-muted-foreground text-sm">to</span>
		<Input type="date" bind:value={toDateInput} onchange={applyFilters} class="w-36" />

		{#if hasActiveFilters}
			<Button variant="ghost" size="sm" onclick={clearFilters} class="gap-1.5">
				<XIcon class="size-3.5" />
				Clear
			</Button>
		{/if}
	</div>

	{#if data.entries.length === 0}
		<p class="text-muted-foreground py-16 text-center text-sm">
			{hasActiveFilters ? 'No events match these filters.' : 'No audit events yet.'}
		</p>
	{:else}
		<ul class="flex flex-col gap-1">
			{#each data.entries as entry (entry.id)}
				<li>
					<button
						type="button"
						class="hover:bg-muted flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors"
						onclick={() => (detailEntry = entry)}
					>
						<span
							class="shrink-0 rounded-full px-2 py-0.5 text-xs {eventTypeBadgeClass(
								entry.eventType
							)}"
						>
							{EVENT_TYPE_LABELS[entry.eventType] ?? entry.eventType}
						</span>
						<span class="text-muted-foreground w-32 shrink-0 truncate">{actorLabel(entry)}</span>
						<span class="text-muted-foreground w-40 shrink-0 truncate">{targetLabel(entry)}</span>
						<span class="text-muted-foreground min-w-0 flex-1 truncate text-xs">
							{detailSummary(entry)}
						</span>
						<span class="text-muted-foreground shrink-0 text-xs"
							>{formatDateTime(entry.createdAt)}</span
						>
					</button>
				</li>
			{/each}
		</ul>

		<div class="mt-4 flex items-center justify-between">
			<p class="text-muted-foreground text-xs">
				Page {data.page} of {totalPages}
			</p>
			<div class="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={data.page <= 1}
					onclick={() => goToPage(data.page - 1)}
				>
					<ChevronLeftIcon class="size-4" />
					Previous
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={data.page >= totalPages}
					onclick={() => goToPage(data.page + 1)}
				>
					Next
					<ChevronRightIcon class="size-4" />
				</Button>
			</div>
		</div>
	{/if}
</div>

<Dialog.Root open={detailEntry !== null} onOpenChange={(open) => !open && (detailEntry = null)}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>
				{detailEntry ? (EVENT_TYPE_LABELS[detailEntry.eventType] ?? detailEntry.eventType) : ''}
			</Dialog.Title>
		</Dialog.Header>
		{#if detailEntry}
			<div class="flex flex-col gap-2 text-sm">
				<div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
					<span class="text-muted-foreground">Time</span>
					<span>{formatDateTime(detailEntry.createdAt)}</span>
					<span class="text-muted-foreground">User</span>
					<span>{detailEntry.username ?? detailEntry.userId ?? '—'}</span>
					<span class="text-muted-foreground">Actor</span>
					<span>{detailEntry.actorUsername ?? detailEntry.actorId ?? '—'}</span>
					<span class="text-muted-foreground">Target</span>
					<span>{targetLabel(detailEntry)}</span>
					<span class="text-muted-foreground">IP address</span>
					<span>{detailEntry.ipAddress ?? '—'}</span>
				</div>
				{#if detailEntry.detail}
					<div>
						<p class="text-muted-foreground mb-1">Detail</p>
						<pre class="bg-muted overflow-x-auto rounded-md p-2 text-xs">{prettyDetail(
								detailEntry.detail
							)}</pre>
					</div>
				{/if}
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
