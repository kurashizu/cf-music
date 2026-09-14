<script lang="ts">
	import { goto } from '$app/navigation';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';

	interface ErrorBody {
		message?: string;
	}

	let activeTab = $state<'login' | 'register'>('login');

	let loginUsername = $state('');
	let loginPassword = $state('');
	let loginError = $state<string | null>(null);
	let loginSubmitting = $state(false);

	let registerUsername = $state('');
	let registerPassword = $state('');
	let registerInviteCode = $state('');
	let registerError = $state<string | null>(null);
	let registerSubmitting = $state(false);

	async function handleLogin(event: SubmitEvent) {
		event.preventDefault();
		loginError = null;
		loginSubmitting = true;
		try {
			const response = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ username: loginUsername, password: loginPassword })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as ErrorBody | null;
				loginError = body?.message ?? '登录失败，请检查用户名和密码';
				return;
			}
			await goto('/library');
		} catch {
			loginError = '网络错误，请稍后重试';
		} finally {
			loginSubmitting = false;
		}
	}

	async function handleRegister(event: SubmitEvent) {
		event.preventDefault();
		registerError = null;
		registerSubmitting = true;
		try {
			const response = await fetch('/api/auth/register', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					username: registerUsername,
					password: registerPassword,
					inviteCode: registerInviteCode
				})
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as ErrorBody | null;
				registerError = body?.message ?? '注册失败，请检查填写内容';
				return;
			}
			await goto('/library');
		} catch {
			registerError = '网络错误，请稍后重试';
		} finally {
			registerSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>登录 · cf-music</title>
</svelte:head>

<div class="flex min-h-svh items-center justify-center bg-background p-4">
	<Card.Root class="w-full max-w-sm">
		<Card.Header>
			<Card.Title class="text-xl">cf-music</Card.Title>
			<Card.Description>私人音乐库，仅限受邀用户访问</Card.Description>
		</Card.Header>
		<Card.Content>
			<Tabs.Root bind:value={activeTab} class="w-full">
				<Tabs.List class="grid w-full grid-cols-2">
					<Tabs.Trigger value="login">登录</Tabs.Trigger>
					<Tabs.Trigger value="register">注册</Tabs.Trigger>
				</Tabs.List>

				<Tabs.Content value="login">
					<form class="flex flex-col gap-4 pt-4" onsubmit={handleLogin}>
						{#if loginError}
							<Alert.Root variant="destructive">
								<Alert.Description>{loginError}</Alert.Description>
							</Alert.Root>
						{/if}
						<div class="flex flex-col gap-2">
							<Label for="login-username">用户名</Label>
							<Input
								id="login-username"
								name="username"
								autocomplete="username"
								required
								bind:value={loginUsername}
							/>
						</div>
						<div class="flex flex-col gap-2">
							<Label for="login-password">密码</Label>
							<Input
								id="login-password"
								name="password"
								type="password"
								autocomplete="current-password"
								required
								bind:value={loginPassword}
							/>
						</div>
						<Button type="submit" class="w-full" disabled={loginSubmitting}>
							{loginSubmitting ? '登录中…' : '登录'}
						</Button>
					</form>
				</Tabs.Content>

				<Tabs.Content value="register">
					<form class="flex flex-col gap-4 pt-4" onsubmit={handleRegister}>
						{#if registerError}
							<Alert.Root variant="destructive">
								<Alert.Description>{registerError}</Alert.Description>
							</Alert.Root>
						{/if}
						<div class="flex flex-col gap-2">
							<Label for="register-username">用户名</Label>
							<Input
								id="register-username"
								name="username"
								autocomplete="username"
								required
								minlength={3}
								maxlength={32}
								bind:value={registerUsername}
							/>
						</div>
						<div class="flex flex-col gap-2">
							<Label for="register-password">密码</Label>
							<Input
								id="register-password"
								name="password"
								type="password"
								autocomplete="new-password"
								required
								minlength={8}
								bind:value={registerPassword}
							/>
						</div>
						<div class="flex flex-col gap-2">
							<Label for="register-invite-code">邀请码</Label>
							<Input
								id="register-invite-code"
								name="inviteCode"
								autocomplete="off"
								required
								bind:value={registerInviteCode}
							/>
						</div>
						<Button type="submit" class="w-full" disabled={registerSubmitting}>
							{registerSubmitting ? '注册中…' : '注册'}
						</Button>
					</form>
				</Tabs.Content>
			</Tabs.Root>
		</Card.Content>
	</Card.Root>
</div>
