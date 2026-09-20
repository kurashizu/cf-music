<script lang="ts">
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import type { SongSortField, SortDirection } from '$lib/shared/song-sort-filter';

	interface SortOption {
		value: SongSortField;
		label: string;
	}

	let {
		sortField = $bindable(),
		sortDirection = $bindable(),
		sortOptions,
		artistFilter = $bindable(null),
		artistOptions = null,
		minDurationMinutes = $bindable(''),
		maxDurationMinutes = $bindable(''),
		showDurationFilter = false,
		extraActiveFilters = 0
	}: {
		sortField: SongSortField;
		sortDirection: SortDirection;
		sortOptions: SortOption[];
		artistFilter?: string | null;
		artistOptions?: string[] | null;
		minDurationMinutes?: string;
		maxDurationMinutes?: string;
		showDurationFilter?: boolean;
		/**
		 * Filters the owning page keeps outside this bar but which still belong
		 * in the collapsed toggle's count — otherwise an active filter is
		 * hidden with no trace on a phone.
		 */
		extraActiveFilters?: number;
	} = $props();

	const sortLabel = $derived(sortOptions.find((o) => o.value === sortField)?.label ?? 'Sort');

	// Collapsed on phones, where the full row of controls crowds out the list
	// itself; always open from sm: up, where it fits on one line.
	let expanded = $state(false);

	// Surfaced on the collapsed toggle so an active filter is never hidden
	// without a trace. The sort field is deliberately excluded: every list has
	// some sort order, so counting it would mean the badge is never absent.
	const activeFilterCount = $derived(
		[
			artistFilter !== null && artistFilter !== 'all',
			minDurationMinutes.trim() !== '',
			maxDurationMinutes.trim() !== ''
		].filter(Boolean).length + extraActiveFilters
	);
</script>

<Button
	variant="outline"
	size="sm"
	class="w-full justify-between gap-2 sm:hidden"
	onclick={() => (expanded = !expanded)}
	aria-expanded={expanded}
>
	<span class="flex items-center gap-2">
		<SlidersHorizontalIcon class="size-4" />
		Sort & filter
		{#if activeFilterCount > 0}
			<span class="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">
				{activeFilterCount}
			</span>
		{/if}
	</span>
	<ChevronDownIcon class="size-4 transition-transform {expanded ? 'rotate-180' : ''}" />
</Button>

<!-- The controls are fluid below sm: fixed widths made them wrap one per
     row on a phone and clipped the duration placeholders. Each one takes an
     equal share of the row instead, and reverts to its natural width once
     there's room. -->
<div class="flex-wrap items-center gap-2 {expanded ? 'flex' : 'hidden'} sm:flex">
	<Select.Root type="single" bind:value={sortField as string}>
		<Select.Trigger class="min-w-0 flex-1 sm:w-36 sm:flex-none">
			{sortLabel}
		</Select.Trigger>
		<Select.Content>
			{#each sortOptions as option (option.value)}
				<Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
			{/each}
		</Select.Content>
	</Select.Root>

	<!-- Kept in place under the stored order, where it has nothing to toggle,
	     so changing sort doesn't shift every control to its right. -->
	<Button
		size="icon-sm"
		variant="outline"
		class={sortField === 'custom' ? 'invisible' : ''}
		disabled={sortField === 'custom'}
		tabindex={sortField === 'custom' ? -1 : 0}
		onclick={() => (sortDirection = sortDirection === 'asc' ? 'desc' : 'asc')}
		aria-label={sortDirection === 'asc' ? 'Sort ascending' : 'Sort descending'}
	>
		{#if sortDirection === 'asc'}
			<ArrowUpIcon class="size-4" />
		{:else}
			<ArrowDownIcon class="size-4" />
		{/if}
	</Button>

	{#if artistOptions && artistOptions.length > 0}
		<Select.Root type="single" bind:value={artistFilter as string}>
			<Select.Trigger class="min-w-0 flex-1 sm:w-40 sm:flex-none">
				{artistFilter === 'all' || !artistFilter ? 'All artists' : artistFilter}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="all" label="All artists">All artists</Select.Item>
				{#each artistOptions as artist (artist)}
					<Select.Item value={artist} label={artist}>{artist}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	{/if}

	{#if showDurationFilter}
		<!-- Takes a row of its own on a phone: sharing one with the selects
		     left each input too narrow to show its own placeholder. -->
		<div class="flex w-full min-w-0 items-center gap-1.5 sm:w-auto sm:flex-none">
			<Input
				type="number"
				min="0"
				placeholder="Min min"
				bind:value={minDurationMinutes}
				class="w-full min-w-0 sm:w-20"
			/>
			<span class="text-sm text-muted-foreground">–</span>
			<Input
				type="number"
				min="0"
				placeholder="Max min"
				bind:value={maxDurationMinutes}
				class="w-full min-w-0 sm:w-20"
			/>
		</div>
	{/if}
</div>
