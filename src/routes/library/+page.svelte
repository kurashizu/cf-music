<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	async function handleLogout() {
		await fetch('/api/auth/logout', { method: 'POST' });
		await invalidateAll();
		await goto('/');
	}
</script>

<svelte:head>
	<title>播放列表 · cf-music</title>
</svelte:head>

<div class="flex min-h-svh flex-col items-center justify-center gap-4 bg-background p-4">
	<p class="text-muted-foreground">已登录：{data.session.username}</p>
	<Button variant="outline" onclick={handleLogout}>退出登录</Button>
</div>
