<script lang="ts">
	interface Props {
		size?: number;
		class?: string;
	}

	let { size = 32, class: className = '' }: Props = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 64 64"
	fill="none"
	xmlns="http://www.w3.org/2000/svg"
	class={className}
	role="img"
	aria-label="KRSZ Music"
>
	<rect x="14" y="10" width="7" height="44" rx="3.5" class="fill-primary" />
	<rect x="27" y="22" width="7" height="20" rx="3.5" class="fill-muted-foreground" />
	<path d="M34 32L50 10" class="stroke-primary" stroke-width="7" stroke-linecap="round" />
	<path d="M34 32L50 54" class="stroke-primary" stroke-width="7" stroke-linecap="round" />
</svg>
