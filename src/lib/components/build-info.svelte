<script lang="ts">
	const buildTime = new Date(__BUILD_TIME__).toLocaleString(undefined, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	});
</script>

<p class="truncate px-2.5 text-[10px] text-muted-foreground/60">
	{__BUILD_COMMIT__} · {buildTime}
</p>
