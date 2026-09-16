<script lang="ts">
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
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
		showDurationFilter = false
	}: {
		sortField: SongSortField;
		sortDirection: SortDirection;
		sortOptions: SortOption[];
		artistFilter?: string | null;
		artistOptions?: string[] | null;
		minDurationMinutes?: string;
		maxDurationMinutes?: string;
		showDurationFilter?: boolean;
	} = $props();

	const sortLabel = $derived(sortOptions.find((o) => o.value === sortField)?.label ?? 'Sort');
</script>

<div class="flex flex-wrap items-center gap-2">
	<Select.Root type="single" bind:value={sortField as string}>
		<Select.Trigger class="w-36">
			{sortLabel}
		</Select.Trigger>
		<Select.Content>
			{#each sortOptions as option (option.value)}
				<Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
			{/each}
		</Select.Content>
	</Select.Root>

	{#if sortField !== 'custom'}
		<Button
			size="icon-sm"
			variant="outline"
			onclick={() => (sortDirection = sortDirection === 'asc' ? 'desc' : 'asc')}
			aria-label={sortDirection === 'asc' ? 'Sort ascending' : 'Sort descending'}
		>
			{#if sortDirection === 'asc'}
				<ArrowUpIcon class="size-4" />
			{:else}
				<ArrowDownIcon class="size-4" />
			{/if}
		</Button>
	{/if}

	{#if artistOptions && artistOptions.length > 0}
		<Select.Root type="single" bind:value={artistFilter as string}>
			<Select.Trigger class="w-40">
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
		<div class="flex items-center gap-1.5">
			<Input
				type="number"
				min="0"
				placeholder="Min min"
				bind:value={minDurationMinutes}
				class="w-20"
			/>
			<span class="text-sm text-muted-foreground">–</span>
			<Input
				type="number"
				min="0"
				placeholder="Max min"
				bind:value={maxDurationMinutes}
				class="w-20"
			/>
		</div>
	{/if}
</div>
