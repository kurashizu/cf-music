import { AwsClient } from 'aws4fetch';
import { encodeObjectKey } from './object-key';

export interface S3Config {
	endpoint: string; // e.g. https://s3api.022025.xyz
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** MinIO defaults to us-east-1 unless configured otherwise server-side. */
	region?: string;
}

export const PRESIGNED_URL_EXPIRY_SECONDS = 24 * 60 * 60; // 1 day, per design

/** Object storage operations needed by the app, kept behind an interface so
 * business logic (eviction, playback) can be tested with a fake instead of
 * making real network calls. */
export interface ObjectStorage {
	presignGetUrl(key: string): Promise<string>;
	deleteObjects(keys: string[]): Promise<void>;
	/** Every object key currently in the bucket — used only by the admin orphan scan, not by normal app operations. */
	listAllKeys(): Promise<string[]>;
}

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

export class S3ObjectStorage implements ObjectStorage {
	private readonly client: AwsClient;
	private readonly baseUrl: string;

	constructor(private readonly config: S3Config) {
		this.client = new AwsClient({
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			service: 's3',
			region: config.region ?? 'us-east-1'
		});
		this.baseUrl = `${config.endpoint.replace(/\/$/, '')}/${config.bucket}`;
	}

	async presignGetUrl(key: string): Promise<string> {
		// X-Amz-Expires belongs in the query string, not `headers` — aws4fetch's
		// signQuery mode writes it into url.searchParams itself (defaulting to
		// 86400s if absent), so setting it via `headers` here doesn't just fail
		// to override that default: it makes aws4fetch treat "X-Amz-Expires" as
		// a signable HTTP header and add it to SignedHeaders, even though no
		// such header is ever actually sent with a GET request. MinIO then sees
		// a SignedHeaders list that includes a header the request doesn't have
		// and rejects the whole request with 400 AccessDenied ("headers present
		// ... which were not signed") — confirmed by reproducing both the
		// broken (headers-based) and working (query-based) URL forms directly
		// against MinIO.
		const url = new URL(`${this.baseUrl}/${encodeObjectKey(key)}`);
		url.searchParams.set('X-Amz-Expires', String(PRESIGNED_URL_EXPIRY_SECONDS));
		const signed = await this.client.sign(url, {
			method: 'GET',
			aws: { signQuery: true }
		});
		return signed.url;
	}

	async listAllKeys(): Promise<string[]> {
		const keys: string[] = [];
		let continuationToken: string | undefined;

		do {
			const url = new URL(this.baseUrl);
			url.searchParams.set('list-type', '2');
			url.searchParams.set('max-keys', '1000');
			if (continuationToken) url.searchParams.set('continuation-token', continuationToken);

			const signed = await this.client.sign(url, { method: 'GET' });
			const response = await this.client.fetch(signed);
			if (!response.ok) {
				throw new Error(`Failed to list bucket objects: ${response.status} ${response.statusText}`);
			}
			const xml = await response.text();

			for (const match of xml.matchAll(/<Key>(.*?)<\/Key>/g)) {
				keys.push(decodeXmlEntities(match[1]));
			}

			const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
			const tokenMatch = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/);
			continuationToken = isTruncated ? tokenMatch?.[1] : undefined;
		} while (continuationToken);

		return keys;
	}

	async deleteObjects(keys: string[]): Promise<void> {
		if (keys.length === 0) return;

		// One DELETE per key: simplest correct approach, and MinIO's bulk
		// delete (POST ?delete) needs an XML body our size doesn't warrant
		// building/parsing for a private, low-volume app.
		for (const key of keys) {
			const url = new URL(`${this.baseUrl}/${encodeObjectKey(key)}`);
			const response = await this.client.fetch(url, { method: 'DELETE' });
			if (!response.ok && response.status !== 404) {
				throw new Error(`Failed to delete S3 object ${key}: ${response.status} ${response.statusText}`);
			}
		}
	}
}
