<script lang="ts">
	const buildTime = new Date(__BUILD_TIME__).toLocaleString(undefined, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	});
</script>

<p class="text-muted-foreground/60 truncate text-[10px]">
	{__BUILD_COMMIT__} · {buildTime}
</p>
