/** Encodes an object key for use in a URL path, preserving '/' as a path separator. */
export function encodeObjectKey(key: string): string {
	return key.split('/').map(encodeURIComponent).join('/');
}
