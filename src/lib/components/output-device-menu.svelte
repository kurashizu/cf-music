<script lang="ts">
	import { player } from '$lib/client/player.svelte';
	import { listAudioOutputDevices, type AudioOutputDevice } from '$lib/client/output-devices';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import SpeakerIcon from '@lucide/svelte/icons/speaker';

	let devices = $state<AudioOutputDevice[]>([]);
	// The radio group's own value is a plain string, but "Auto" is
	// player.outputDeviceId === null — this local sentinel stands in for
	// that so the group always has a real string to bind, translated back
	// to null right before calling setOutputDevice.
	const AUTO_VALUE = '__auto__';
	let radioValue = $derived(player.outputDeviceId ?? AUTO_VALUE);

	async function loadDevices() {
		devices = await listAudioOutputDevices();
	}

	function handleSelect(value: string) {
		player.setOutputDevice(value === AUTO_VALUE ? null : value);
	}
</script>

{#if player.outputDeviceSupported}
	<DropdownMenu.Root onOpenChange={(open) => open && loadDevices()}>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="ghost"
					size="icon-sm"
					class="hidden text-muted-foreground sm:flex"
					aria-label="Output device"
				>
					<SpeakerIcon class="size-4" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-56">
			<DropdownMenu.RadioGroup value={radioValue} onValueChange={handleSelect}>
				<DropdownMenu.RadioItem value={AUTO_VALUE}>Auto (system default)</DropdownMenu.RadioItem>
				{#each devices as device (device.deviceId)}
					<DropdownMenu.RadioItem value={device.deviceId}>{device.label}</DropdownMenu.RadioItem>
				{/each}
			</DropdownMenu.RadioGroup>
			{#if player.outputDeviceError}
				<p class="px-1.5 pt-1.5 text-xs text-destructive">{player.outputDeviceError}</p>
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
