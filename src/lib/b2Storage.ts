import {
  S3Client,
  ListObjectVersionsCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import crypto from 'crypto';

const B2_KEY_ID = process.env.B2_KEY_ID?.trim() || '0050ef4f72b70800000000009';
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY?.trim() || 'K005X1hRegI1IdPGbWyZr75idEu+Bnc';
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME?.trim() || 'cloudvalt-storage';
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

export async function uploadFileToB2(
  fileKey: string,
  buffer: Buffer,
  contentType: string,
  userId: string
): Promise<B2UploadResult> {
  const safeFileName = fileKey.replace(/[^a-zA-Z0-9._-]/g, '_');
  const b2FileName = `users/${userId}/${safeFileName}`;

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
  const rawFileName = objectKey.split('/').pop() || objectKey;
  const safeFileName = rawFileName.replace(/[^a-zA-Z0-9._-]/g, '_');

  const candidateKeys = [
    objectKey,
    safeFileName,
    rawFileName,
    userId ? `users/${userId}/${safeFileName}` : null,
    userId ? `users/${userId}/${rawFileName}` : null,
    userId ? `users/${userId}/${objectKey}` : null,
  ].filter(Boolean) as string[];

  const uniqueKeys = Array.from(new Set(candidateKeys));
  const prefixesToScan = Array.from(
    new Set([
      ...uniqueKeys,
      userId ? `users/${userId}/` : null,
      objectKey.includes('/') ? objectKey.substring(0, objectKey.lastIndexOf('/') + 1) : null,
    ].filter(Boolean) as string[])
  );

  let anyWiped = false;

  // 1. Scan prefixes and delete every Version AND DeleteMarker by VersionId
  for (const prefix of prefixesToScan) {
    try {
      let KeyMarker: string | undefined;
      let VersionIdMarker: string | undefined;

      do {
        const result = await s3.send(
          new ListObjectVersionsCommand({
            Bucket: B2_BUCKET_NAME,
            Prefix: prefix,
            KeyMarker,
            VersionIdMarker,
          })
        );

        const allEntries = [
          ...(result.Versions || []).map((v) => ({ Key: v.Key, VersionId: v.VersionId, type: 'version' })),
          ...(result.DeleteMarkers || []).map((m) => ({ Key: m.Key, VersionId: m.VersionId, type: 'delete-marker' })),
        ];

        // Filter entries that match candidate keys or end with the target filename
        const matchingEntries = allEntries.filter((item) => {
          if (!item.Key) return false;
          return (
            uniqueKeys.includes(item.Key) ||
            item.Key.endsWith(`/${rawFileName}`) ||
            item.Key.endsWith(`/${safeFileName}`) ||
            item.Key === rawFileName ||
            item.Key === safeFileName
          );
        });

        for (const entry of matchingEntries) {
          if (entry.Key && entry.VersionId) {
            try {
              // Deleting with VersionId permanently destroys the version or delete marker
              // and DOES NOT leave a 0-byte delete marker behind!
              await s3.send(
                new DeleteObjectCommand({
                  Bucket: B2_BUCKET_NAME,
                  Key: entry.Key,
                  VersionId: entry.VersionId,
                })
              );
              anyWiped = true;
              console.log(`[B2] Purged ${entry.type}: ${entry.Key} (VersionId: ${entry.VersionId})`);
            } catch (err: any) {
              console.warn(`[B2] Error deleting ${entry.type} ${entry.Key}:`, err?.message);
            }
          }
        }

        KeyMarker = result.NextKeyMarker;
        VersionIdMarker = result.NextVersionIdMarker;

        if (!result.IsTruncated) {
          break;
        }
      } while (true);
    } catch (err: any) {
      console.warn(`[B2] Prefix scan error for prefix ${prefix}:`, err?.message);
    }
  }

  // 2. Final check pass: ensure no lingering DeleteMarkers remain for any candidate key
  for (const key of uniqueKeys) {
    try {
      const check = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: B2_BUCKET_NAME,
          Prefix: key,
        })
      );

      const lingeringMarkers = (check.DeleteMarkers || []).filter(
        (m) => m.Key === key && m.VersionId
      );
      for (const marker of lingeringMarkers) {
        if (marker.Key && marker.VersionId) {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: B2_BUCKET_NAME,
              Key: marker.Key,
              VersionId: marker.VersionId,
            })
          );
          console.log(`[B2] Cleaned lingering delete marker for ${marker.Key}`);
        }
      }
    } catch {}
  }

  return anyWiped;
}
