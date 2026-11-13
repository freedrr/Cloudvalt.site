import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  ListObjectVersionsCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import crypto from 'crypto';
import fs from 'fs';
import { Transform } from 'stream';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const B2_KEY_ID = process.env.B2_KEY_ID?.trim() || '';
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY?.trim() || '';
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME?.trim() || '';
const B2_REGION = process.env.B2_REGION?.trim() || 'us-east-005';
const B2_ENDPOINT =
  process.env.B2_ENDPOINT?.trim() ||
  `https://s3.${B2_REGION}.backblazeb2.com`;

export function isB2Configured(): boolean {
  return Boolean(B2_KEY_ID && B2_APPLICATION_KEY && B2_BUCKET_NAME);
}

function getS3Client(): S3Client {
  return new S3Client({
    endpoint: B2_ENDPOINT.startsWith('http') ? B2_ENDPOINT : `https://${B2_ENDPOINT}`,
    region: B2_REGION,
    credentials: {
      accessKeyId: B2_KEY_ID,
      secretAccessKey: B2_APPLICATION_KEY,
    },
    forcePathStyle: true,
  });
}

export interface B2UploadResult {
  b2FileId: string;
  b2FileName: string;
  b2BucketName: string;
  size: number;
  url: string;
  storedInB2: boolean;
}

export interface B2MultipartSession {
  b2FileName: string;
  b2BucketName: string;
  uploadId: string;
}

export async function beginB2MultipartUpload(
  fileName: string,
  contentType: string,
  userId: string
): Promise<B2MultipartSession> {
  if (!isB2Configured()) throw new Error('Cloud storage is not configured.');
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const b2FileName = `users/${userId}/${crypto.randomUUID()}_${safeFileName}`;
  const result = await getS3Client().send(new CreateMultipartUploadCommand({
    Bucket: B2_BUCKET_NAME,
    Key: b2FileName,
    ContentType: contentType || 'application/octet-stream',
  }));
  if (!result.UploadId) throw new Error('Cloud storage did not create an upload session.');
  return { b2FileName, b2BucketName: B2_BUCKET_NAME, uploadId: result.UploadId };
}

export async function createB2MultipartPartUrl(
  session: B2MultipartSession,
  partNumber: number
): Promise<string> {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new Error('Invalid multipart part number.');
  }
  return getSignedUrl(getS3Client(), new UploadPartCommand({
    Bucket: session.b2BucketName,
    Key: session.b2FileName,
    UploadId: session.uploadId,
    PartNumber: partNumber,
  }), { expiresIn: 60 * 60 });
}

export async function uploadB2MultipartPartFromDisk(
  session: B2MultipartSession,
  partNumber: number,
  filePath: string,
  contentLength: number,
  onProgress?: (bytesSent: number) => void
): Promise<string> {
  let bytesSent = 0;
  const body = fs.createReadStream(filePath).pipe(new Transform({
    transform(chunk, _encoding, callback) {
      bytesSent += chunk.length;
      onProgress?.(bytesSent);
      callback(null, chunk);
    },
  }));
  const result = await getS3Client().send(new UploadPartCommand({
    Bucket: session.b2BucketName,
    Key: session.b2FileName,
    UploadId: session.uploadId,
    PartNumber: partNumber,
    Body: body,
    ContentLength: contentLength,
  }));
  if (!result.ETag) throw new Error(`Cloud storage did not confirm upload part ${partNumber}.`);
  return result.ETag;
}

export async function completeB2MultipartUpload(
  session: B2MultipartSession,
  parts: { ETag: string; PartNumber: number }[],
  size: number
): Promise<B2UploadResult> {
  const result = await getS3Client().send(new CompleteMultipartUploadCommand({
    Bucket: session.b2BucketName,
    Key: session.b2FileName,
    UploadId: session.uploadId,
    MultipartUpload: { Parts: parts },
  }));
  return {
    b2FileId: result.ETag?.replace(/\"/g, '') || `multipart_${crypto.randomUUID()}`,
    b2FileName: session.b2FileName,
    b2BucketName: session.b2BucketName,
    size,
    url: `/api/files/${encodeURIComponent(session.b2FileName)}`,
    storedInB2: true,
  };
}

export async function abortB2MultipartUpload(session: B2MultipartSession): Promise<void> {
  await getS3Client().send(new AbortMultipartUploadCommand({
    Bucket: session.b2BucketName,
    Key: session.b2FileName,
    UploadId: session.uploadId,
  }));
}

export async function uploadFileToB2(
  fileKey: string,
  buffer: Buffer,
  contentType: string,
  userId: string
): Promise<B2UploadResult> {
  const safeFileName = fileKey.replace(/[^a-zA-Z0-9._-]/g, '_');
  const b2FileName = `users/${userId}/${crypto.randomUUID()}_${safeFileName}`;

  if (!isB2Configured()) {
    throw new Error('Backblaze B2 credentials (B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME) are not configured.');
  }

  const s3 = getS3Client();
  const command = new PutObjectCommand({
    Bucket: B2_BUCKET_NAME,
    Key: b2FileName,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  });

  const response = await s3.send(command);
  const b2FileId =
    response.ETag?.replace(/"/g, '') ||
    `4_z${crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 24)}`;

  return {
    b2FileId,
    b2FileName,
    b2BucketName: B2_BUCKET_NAME,
    size: buffer.length,
    url: `/api/files/${safeFileName}`,
    storedInB2: true,
  };
}

export async function uploadFileFromDiskToB2(
  fileName: string,
  filePath: string,
  fileSize: number,
  contentType: string,
  userId: string,
  onProgress?: (uploadedBytes: number) => void
): Promise<B2UploadResult> {
  if (!isB2Configured()) {
    throw new Error('Backblaze B2 credentials (B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME) are not configured.');
  }

  const s3 = getS3Client();
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const b2FileName = `users/${userId}/${crypto.randomUUID()}_${safeFileName}`;
  const createResult = await s3.send(new CreateMultipartUploadCommand({
    Bucket: B2_BUCKET_NAME,
    Key: b2FileName,
    ContentType: contentType || 'application/octet-stream',
  }));

  if (!createResult.UploadId) {
    throw new Error('Backblaze B2 did not return an upload session.');
  }

  const partSize = Math.max(64 * 1024 * 1024, Math.ceil(fileSize / 10_000));
  const parts: { ETag?: string; PartNumber: number }[] = [];

  try {
    const partCount = Math.ceil(fileSize / partSize);
    const loadedByPart = new Map<number, number>();
    const uploadPart = async (index: number) => {
      const start = index * partSize;
      const end = Math.min(fileSize, start + partSize) - 1;
      const partLength = end - start + 1;
      let partLoaded = 0;
      const body = fs.createReadStream(filePath, { start, end }).pipe(new Transform({
        transform(chunk, _encoding, callback) {
          partLoaded += chunk.length;
          loadedByPart.set(index, partLoaded);
          onProgress?.(Array.from(loadedByPart.values()).reduce((sum, value) => sum + value, 0));
          callback(null, chunk);
        },
      }));
      const result = await s3.send(new UploadPartCommand({
        Bucket: B2_BUCKET_NAME,
        Key: b2FileName,
        UploadId: createResult.UploadId,
        PartNumber: index + 1,
        Body: body,
        ContentLength: partLength,
      }));
      return { ETag: result.ETag, PartNumber: index + 1 };
    };

    const partResults = new Map<number, { ETag?: string; PartNumber: number }>();
    let nextPart = 0;
    const uploadWorker = async () => {
      while (true) {
        const index = nextPart++;
        if (index >= partCount) return;
        partResults.set(index, await uploadPart(index));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, partCount) }, () => uploadWorker()));
    for (let index = 0; index < partCount; index++) {
      const part = partResults.get(index);
      if (!part) throw new Error(`Cloud upload part ${index + 1} did not finish.`);
      parts.push(part);
    }

    const completed = await s3.send(new CompleteMultipartUploadCommand({
      Bucket: B2_BUCKET_NAME,
      Key: b2FileName,
      UploadId: createResult.UploadId,
      MultipartUpload: { Parts: parts },
    }));

    return {
      b2FileId: completed.ETag?.replace(/"/g, '') || `multipart_${crypto.randomUUID()}`,
      b2FileName,
      b2BucketName: B2_BUCKET_NAME,
      size: fileSize,
      url: `/api/files/${encodeURIComponent(b2FileName)}`,
      storedInB2: true,
    };
  } catch (error) {
    await s3.send(new AbortMultipartUploadCommand({
      Bucket: B2_BUCKET_NAME,
      Key: b2FileName,
      UploadId: createResult.UploadId,
    })).catch(() => {});
    throw error;
  }
}

export async function openFileFromB2(
  fileKey: string,
  userId?: string,
  range?: string
): Promise<{ body: any; contentType: string; contentLength?: number; contentRange?: string; acceptRanges?: string } | null> {
  if (!isB2Configured()) return null;

  const s3 = getS3Client();
  const safeFileName = fileKey.replace(/[^a-zA-Z0-9._/-]/g, '_');
  const candidates = Array.from(new Set([
    fileKey,
    userId ? `users/${userId}/${safeFileName}` : '',
    userId ? `users/${userId}/${fileKey}` : '',
    safeFileName,
  ].filter(Boolean)));

  for (const key of candidates) {
    try {
      const response = await s3.send(new GetObjectCommand({
        Bucket: B2_BUCKET_NAME,
        Key: key,
        Range: range,
      }));
      if (response.Body) {
        return {
          body: response.Body,
          contentType: response.ContentType || 'application/octet-stream',
          contentLength: response.ContentLength,
          contentRange: response.ContentRange,
          acceptRanges: response.AcceptRanges,
        };
      }
    } catch {
      // Continue with the next supported legacy key format.
    }
  }

  return null;
}

export async function downloadFileFromB2(
  fileKey: string,
  userId?: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!isB2Configured()) {
    throw new Error('Backblaze B2 is not configured.');
  }

  const s3 = getS3Client();
  const safeFileName = fileKey.replace(/[^a-zA-Z0-9._-]/g, '_');

  const candidates = [
    fileKey,
    userId ? `users/${userId}/${safeFileName}` : null,
    userId ? `users/${userId}/${fileKey}` : null,
    safeFileName,
  ].filter(Boolean) as string[];

  const uniqueKeys = Array.from(new Set(candidates));

  for (const key of uniqueKeys) {
    try {
      const command = new GetObjectCommand({
        Bucket: B2_BUCKET_NAME,
        Key: key,
      });

      const response = await s3.send(command);
      if (response.Body) {
        const streamToBuffer = async (stream: any): Promise<Buffer> => {
          const chunks: any[] = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          return Buffer.concat(chunks);
        };
        const buffer = await streamToBuffer(response.Body);
        return {
          buffer,
          contentType: response.ContentType || 'application/octet-stream',
        };
      }
    } catch {
      // Try next key candidate
    }
  }

  return null;
}

export async function deleteFileFromB2(
  fileKey: string,
  userId?: string
): Promise<boolean> {
  // Delegate to permanent delete to prevent leaving 0-byte delete markers
  return permanentlyDeleteB2File(fileKey, userId);
}

export async function permanentlyDeleteB2File(objectKey: string, userId?: string): Promise<boolean> {
  if (!objectKey) {
    throw new Error("B2 object key is required");
  }

  if (!isB2Configured()) {
    console.warn('Backblaze B2 is not configured for deletion.');
    return false;
  }

  const s3 = getS3Client();
  // Match only the exact object key. Filename suffix matching can erase a
  // different user's file when two users upload files with the same name.
  if (userId && !objectKey.startsWith(`users/${userId}/`)) {
    throw new Error('B2 object key does not belong to the requesting user');
  }

  let wipedAny = false;
  let KeyMarker: string | undefined;
  let VersionIdMarker: string | undefined;
  do {
    const result = await s3.send(new ListObjectVersionsCommand({
      Bucket: B2_BUCKET_NAME,
      Prefix: objectKey,
      KeyMarker,
      VersionIdMarker,
    }));
    const entries = [
      ...(result.Versions || []).map((entry) => ({ ...entry, entryType: 'version' as const })),
      ...(result.DeleteMarkers || []).map((entry) => ({ ...entry, entryType: 'delete marker' as const })),
    ].filter((entry) => entry.Key === objectKey && entry.VersionId);

    for (const entry of entries) {
      await s3.send(new DeleteObjectCommand({
        Bucket: B2_BUCKET_NAME,
        Key: objectKey,
        VersionId: entry.VersionId,
      }));
      wipedAny = true;
      console.log(`[B2] Permanently removed ${entry.entryType}: ${objectKey}`);
    }

    KeyMarker = result.NextKeyMarker;
    VersionIdMarker = result.NextVersionIdMarker;
    if (!result.IsTruncated) break;
  } while (true);

  return wipedAny;
}
