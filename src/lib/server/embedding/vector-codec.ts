/**
 * Serializes a 768-dim embedding as a flat float32 blob for storage in D1's
 * BLOB column type, and back. Buffer.from's .buffer can be a larger,
 * pooled ArrayBuffer than the view itself, so encode/decode always slice to
 * exactly byteOffset..byteOffset+byteLength rather than assuming buffer and
 * view share the same bounds.
 */
export function encodeVector(values: number[]): Uint8Array {
	return new Uint8Array(Float32Array.from(values).buffer);
}

export function decodeVector(blob: ArrayBuffer | Uint8Array): Float32Array {
	const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
	return new Float32Array(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
	);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
