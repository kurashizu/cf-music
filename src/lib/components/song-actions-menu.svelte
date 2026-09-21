<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import ListPlusIcon from '@lucide/svelte/icons/list-plus';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import GlobeIcon from '@lucide/svelte/icons/globe';

	interface Props {
		/** Whether this row's menu is the open one. */
		open: boolean;
		canReorder: boolean;
		canRemove: boolean;
		canMoveOut: boolean;
		isFirst: boolean;
		isLast: boolean;
		/** Whether copying/moving is available here at all — false offline. */
		canCopy: boolean;
		/** Offers "Clear from cache" — only meaningful where the row is cached. */
		canClearCache?: boolean;
		variant?: 'ghost' | 'secondary';
		class?: string;
		onOpenChange: (open: boolean) => void;
		onAddToQueue: () => void;
		onCopy: () => void;
		onMove: () => void;
		onRemove: () => void;
		onDelete: () => void;
		onMoveUp: () => void;
		onMoveDown: () => void;
		onClearCache?: () => void;
	}

	let {
		open,
		canReorder,
		canRemove,
		canMoveOut,
		isFirst,
		isLast,
		canCopy,
		canClearCache = false,
		variant = 'ghost',
		class: className = '',
		onOpenChange,
		onAddToQueue,
		onCopy,
		onMove,
		onRemove,
		onDelete,
		onMoveUp,
		onMoveDown,
		onClearCache
	}: Props = $props();
</script>

<DropdownMenu.Root bind:open={() => open, (next) => onOpenChange(next)}>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} {variant} size="icon-sm" aria-label="Song options" class={className}>
				<MoreHorizontalIcon class="size-4" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<!-- Only the open row's menu is built. Every row carries one of these and
	     the list can hold a hundred rows, so constructing each menu's
	     positioning and context machinery up front costs real memory for UI
	     that is almost never open. -->
	{#if open}
		<DropdownMenu.Content align="end" class="min-w-52">
			{#if canReorder}
				<DropdownMenu.Item disabled={isFirst} onclick={onMoveUp}>
					<ArrowUpIcon class="size-4" />
					Move up
				</DropdownMenu.Item>
				<DropdownMenu.Item disabled={isLast} onclick={onMoveDown}>
					<ArrowDownIcon class="size-4" />
					Move down
				</DropdownMenu.Item>
			{/if}
			<DropdownMenu.Item onclick={onAddToQueue}>
				<ListPlusIcon class="size-4" />
				Add to queue
			</DropdownMenu.Item>
			<!-- Gated on copying being possible at all (it isn't offline), not
			     on a destination already existing: the dialog can create one,
			     so requiring one left someone whose only playlist is the one
			     they're standing in with no route to a second. -->
			{#if canCopy}
				<DropdownMenu.Item onclick={onCopy}>
					<ListMusicIcon class="size-4" />
					Copy to playlist…
				</DropdownMenu.Item>
				{#if canMoveOut}
					<DropdownMenu.Item onclick={onMove}>
						<ListMusicIcon class="size-4" />
						Move to playlist…
					</DropdownMenu.Item>
				{/if}
			{/if}
			{#if canClearCache && onClearCache}
				<DropdownMenu.Item onclick={onClearCache}>
					<GlobeIcon class="size-4" />
					Clear from cache
				</DropdownMenu.Item>
			{/if}
			{#if canRemove}
				<DropdownMenu.Item onclick={onRemove}>
					<ListMusicIcon class="size-4" />
					Remove from playlist
				</DropdownMenu.Item>
			{/if}
			<DropdownMenu.Item variant="destructive" onclick={onDelete}>
				<Trash2Icon class="size-4" />
				Delete from library
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	{/if}
</DropdownMenu.Root>
