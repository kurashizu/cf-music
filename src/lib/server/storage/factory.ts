import { S3ObjectStorage, type ObjectStorage } from './s3';

export function getObjectStorage(env: Env): ObjectStorage {
	return new S3ObjectStorage({
		endpoint: env.MINIO_ENDPOINT,
		bucket: env.MINIO_BUCKET,
		accessKeyId: env.MINIO_ACCESS_KEY,
		secretAccessKey: env.MINIO_SECRET_KEY
	});
}
