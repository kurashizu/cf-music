/**
 * Splits `items` into chunks of at most `size`. Used to keep SQL `IN (...)`
 * clauses under D1/SQLite's bound-parameter limit (999) when checking a
 * large batch of video ids against the songs table in one round of queries.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
	if (size <= 0) return items.length === 0 ? [] : [items.slice()];

	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}
