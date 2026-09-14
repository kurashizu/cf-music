/** Extracts string fields from an unknown JSON body, or returns null if any are missing/wrong-typed. */
export function pickStrings<K extends string>(
	body: unknown,
	keys: readonly K[]
): Record<K, string> | null {
	if (typeof body !== 'object' || body === null) return null;

	const record = body as Record<string, unknown>;
	const result = {} as Record<K, string>;

	for (const key of keys) {
		const value = record[key];
		if (typeof value !== 'string') return null;
		result[key] = value;
	}

	return result;
}
