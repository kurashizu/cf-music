<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** The icon for this particular emptiness — a playlist, a drive, a cloud. */
		icon: Snippet;
		/** One line saying what isn't here. */
		message: string;
		/** Optional follow-on: a hint paragraph, or an action that fills the gap. */
		children?: Snippet;
	}

	let { icon, message, children }: Props = $props();
</script>

<!--
	Four pages drew this dashed box themselves, differing only in the icon, the
	message, and whether something followed it.
-->
<div
	class="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center"
>
	{@render icon()}
	<p class="text-muted-foreground text-sm">{message}</p>
	{#if children}
		{@render children()}
	{/if}
</div>
