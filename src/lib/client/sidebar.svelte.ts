const STORAGE_KEY = 'krsz-music:sidebar-collapsed';

function readStored(): boolean {
	if (typeof localStorage === 'undefined') return false;
	return localStorage.getItem(STORAGE_KEY) === 'true';
}

/** Whether the desktop sidebar shows an icon-only rail instead of icon+label rows — mobile has no equivalent (it already collapses to a bottom nav). */
class SidebarStore {
	collapsed = $state<boolean>(readStored());

	toggle(): void {
		this.collapsed = !this.collapsed;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, String(this.collapsed));
		}
	}
}

export const sidebar = new SidebarStore();
