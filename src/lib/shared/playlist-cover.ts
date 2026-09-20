/**
 * How many covers a playlist's mosaic thumbnail shows.
 *
 * Shared because both sides have to agree: the server's window function
 * selects this many covers per playlist, and the client only draws a 2x2 grid
 * when it has exactly this many. Kept in one place so raising it can't leave
 * the query and the layout disagreeing.
 */
export const PLAYLIST_MOSAIC_COVER_COUNT = 4;
