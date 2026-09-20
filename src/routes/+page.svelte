<script lang="ts">
	import { goto } from '$app/navigation';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import Logo from '$lib/components/logo.svelte';
	import { slide } from 'svelte/transition';
	import { motionParams } from '$lib/client/motion';

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
				loginError = body?.message ?? 'Login failed, please check your username and password';
				return;
			}
			await goto('/library');
		} catch {
			loginError = 'Network error, please try again';
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
				registerError = body?.message ?? 'Registration failed, please check your details';
				return;
			}
			await goto('/library');
		} catch {
			registerError = 'Network error, please try again';
		} finally {
			registerSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>Login · KRSZ Music</title>
</svelte:head>

<div class="bg-background flex min-h-svh items-center justify-center p-4">
	<Card.Root class="w-full max-w-sm">
		<Card.Header>
			<div class="mb-2 flex items-center gap-2">
				<Logo size={28} />
				<Card.Title class="text-xl">KRSZ Music</Card.Title>
			</div>
			<Card.Description>Private music library, invite-only access</Card.Description>
		</Card.Header>
		<Card.Content>
			<Tabs.Root bind:value={activeTab} class="w-full">
				<Tabs.List class="grid w-full grid-cols-2">
					<Tabs.Trigger value="login">Login</Tabs.Trigger>
					<Tabs.Trigger value="register">Register</Tabs.Trigger>
				</Tabs.List>

				<Tabs.Content value="login">
					<form class="flex flex-col gap-4 pt-4" onsubmit={handleLogin}>
						{#if loginError}
							<div transition:slide={motionParams({ duration: 150 })}>
								<Alert.Root variant="destructive">
									<Alert.Description>{loginError}</Alert.Description>
								</Alert.Root>
							</div>
						{/if}
						<div class="flex flex-col gap-2">
							<Label for="login-username">Username</Label>
							<Input
								id="login-username"
								name="username"
								autocomplete="username"
								required
								bind:value={loginUsername}
							/>
						</div>
						<div class="flex flex-col gap-2">
							<Label for="login-password">Password</Label>
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
							{loginSubmitting ? 'Logging in…' : 'Login'}
						</Button>
					</form>
				</Tabs.Content>

				<Tabs.Content value="register">
					<form class="flex flex-col gap-4 pt-4" onsubmit={handleRegister}>
						{#if registerError}
							<div transition:slide={motionParams({ duration: 150 })}>
								<Alert.Root variant="destructive">
									<Alert.Description>{registerError}</Alert.Description>
								</Alert.Root>
							</div>
						{/if}
						<div class="flex flex-col gap-2">
							<Label for="register-username">Username</Label>
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
							<Label for="register-password">Password</Label>
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
							<Label for="register-invite-code">Invite code</Label>
							<Input
								id="register-invite-code"
								name="inviteCode"
								autocomplete="off"
								required
								bind:value={registerInviteCode}
							/>
						</div>
						<Button type="submit" class="w-full" disabled={registerSubmitting}>
							{registerSubmitting ? 'Registering…' : 'Register'}
						</Button>
					</form>
				</Tabs.Content>
			</Tabs.Root>
		</Card.Content>
	</Card.Root>
</div>
