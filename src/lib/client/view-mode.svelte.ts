export type ViewMode = 'list' | 'grid';

const STORAGE_KEY = 'krsz-music:view-mode';

function readStored(): ViewMode {
	if (typeof localStorage === 'undefined') return 'list';
	return localStorage.getItem(STORAGE_KEY) === 'grid' ? 'grid' : 'list';
}

/**
 * One global list/grid preference shared across every song-list page
 * (playlist detail, smart playlist, storage management) — a per-page
 * preference would mean switching to grid on one playlist and finding
 * every other list still in list view, which isn't what "switch the
 * view" means to a user picking a display preference.
 */
class ViewModeStore {
	mode = $state<ViewMode>(readStored());

	set(mode: ViewMode): void {
		this.mode = mode;
		if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, mode);
	}

	toggle(): void {
		this.set(this.mode === 'list' ? 'grid' : 'list');
	}
}

export const viewMode = new ViewModeStore();
