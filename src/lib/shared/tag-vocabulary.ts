// The fixed candidate vocabulary for zero-shot song classification (see
// songs.autoTags in schema.ts). Validated by actually embedding all of
// these via gemini-embedding-2 and computing their pairwise cosine
// similarity — genuinely near-duplicate pairs were pruned or merged
// before arriving at this list; some deliberately-close pairs were kept
// anyway (e.g. female vocal/male vocal are meant to be opposite poles of
// the same axis, not merged).
export const TAG_VOCABULARY = {
	genre: [
		'jazz', 'classical', 'hip hop', 'rock', 'metal', 'pop', 'electronic',
		'house', 'techno', 'ambient', 'folk', 'country', 'blues', 'funk',
		'soul', 'reggae', 'latin', 'city pop', 'j-pop', 'k-pop', 'anime song',
		'vocaloid', 'soundtrack'
	],
	mood: [
		'energetic', 'chill', 'upbeat', 'melancholic', 'dark', 'dreamy',
		'romantic', 'nostalgic', 'aggressive', 'triumphant', 'playful',
		'sensual', 'tense', 'ethereal', 'groovy', 'introspective'
	],
	instrumentation: [
		'instrumental', 'vocal-driven', 'acoustic', 'orchestral',
		'synth-heavy', 'piano-led', 'guitar-driven', 'a cappella',
		'falsetto', 'female vocal', 'male vocal', 'choral', 'lo-fi',
		'beat-driven'
	]
} as const;

export type TagFacet = keyof typeof TAG_VOCABULARY;

export function allTags(): { tag: string; facet: TagFacet }[] {
	return (Object.entries(TAG_VOCABULARY) as [TagFacet, readonly string[]][]).flatMap(
		([facet, tags]) => tags.map((tag) => ({ tag, facet }))
	);
}
