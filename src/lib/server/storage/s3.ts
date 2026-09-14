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
		const url = new URL(`${this.baseUrl}/${encodeObjectKey(key)}`);
		const signed = await this.client.sign(url, {
			method: 'GET',
			aws: { signQuery: true },
			headers: { 'X-Amz-Expires': String(PRESIGNED_URL_EXPIRY_SECONDS) }
		});
		return signed.url;
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
