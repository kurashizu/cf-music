/**
 * Telling "this track finished" apart from "something took the audio away".
 *
 * A media element fires `pause` immediately before `ended` — verified in
 * Chrome: pause@0.40 (paused=true), then ended@0.40. The player recovers from
 * a vanished output device by treating an unasked-for pause as that signal,
 * so without this distinction every natural end triggered the recovery: it
 * reloaded the finished track and seeked back to its own end while the next
 * one was already loading, and playback froze at "3:04 / 3:04" with the
 * progress bar jittering.
 *
 * Extracted from the player because the player cannot be unit-tested — it
 * builds an `Audio` element on import — and this is the arithmetic that
 * decides whether that bug is back.
 */

/**
 * How close to the duration still counts as the end.
 *
 * `currentTime` can stop a few milliseconds short of `duration`, so an exact
 * comparison would miss. Small enough that a real mid-track pause — losing a
 * headphone — is never inside it.
 */
export const END_OF_MEDIA_TOLERANCE_SECONDS = 0.25;

export interface MediaEndState {
	/** The element's own `ended` flag, which is authoritative when set. */
	ended: boolean;
	currentTime: number;
	/** NaN or Infinity until metadata has loaded. */
	duration: number;
}

/**
 * True when the element is paused because it ran out of media.
 *
 * `ended` is the reliable signal but arrives after `pause`; the duration
 * comparison covers that same instant.
 */
export function isAtEndOfMedia(state: MediaEndState): boolean {
	if (state.ended) return true;
	const { duration, currentTime } = state;
	if (!Number.isFinite(duration) || duration <= 0) return false;
	return currentTime >= duration - END_OF_MEDIA_TOLERANCE_SECONDS;
}
