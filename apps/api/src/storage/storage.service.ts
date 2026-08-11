import { Injectable } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import type { Readable } from 'stream';

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.MINIO_BUCKET ?? 'documents';
    this.client = new S3Client({
      endpoint: process.env.MINIO_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY ?? '',
        secretAccessKey: process.env.MINIO_SECRET_KEY ?? '',
      },
    });
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObjectStream(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return result.Body as Readable;
  }

  async deleteObjects(keys: string[]): Promise<void> {
    // S3 DeleteObjects accepts at most 1,000 keys per request.
    for (let start = 0; start < keys.length; start += 1000) {
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.slice(start, start + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (result.Errors && result.Errors.length > 0) {
        throw new Error(`Failed to permanently delete ${result.Errors.length} storage object(s)`);
      }
    }
  }
}
