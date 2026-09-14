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

/** Type guard for "an array of strings", used to validate JSON body arrays. */
export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Extracts a named field from an unknown JSON body if it's an array of strings. */
export function pickStringArray<K extends string>(body: unknown, key: K): string[] | null {
	if (typeof body !== 'object' || body === null) return null;

	const value = (body as Record<string, unknown>)[key];
	return isStringArray(value) ? value : null;
}

/** Extracts a named field from an unknown JSON body if it's a finite number > 0. */
export function pickPositiveNumber<K extends string>(body: unknown, key: K): number | null {
	if (typeof body !== 'object' || body === null) return null;

	// Number.isFinite (unlike the global isFinite) never coerces: it's false
	// for any non-`number`-typed value, so an explicit `typeof value ===
	// 'number'` check ahead of it would be redundant.
	const value = (body as Record<string, unknown>)[key];
	return Number.isFinite(value) && (value as number) > 0 ? (value as number) : null;
}
