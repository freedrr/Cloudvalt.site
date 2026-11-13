import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { beginB2MultipartUpload, createB2MultipartPartUrl, completeB2MultipartUpload, abortB2MultipartUpload, type B2MultipartSession, openFileFromB2, permanentlyDeleteB2File, isB2Configured } from './src/lib/b2Storage';
import { serverStorage, detectFileType, resolveMimeType } from './src/lib/serverStorage';
import { createServer as createViteServer } from 'vite';

import { adminAuth, adminDb } from './src/lib/firebase-admin';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const FREE_STORAGE_BYTES = 100 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024 * 1024;
type UploadSession = {
  userId: string;
  fileSize: number;
  chunkSize: number;
  maxBytes: number;
  createdAt: number;
  phase: 'receiving' | 'assembling' | 'cloud_upload' | 'finalizing' | 'complete' | 'error';
  receivedBytes: number;
  cloudUploadedBytes: number;
  b2Multipart: B2MultipartSession;
  parts: Map<number, { ETag: string; PartNumber: number }>;
  partSizes: Map<number, number>;
  cloudBytesByPart: Map<number, number>;
};
const uploadSessions = new Map<string, UploadSession>();

// Authentication Middleware with graceful fallback
const authenticate = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1];
    try {
      const decodedToken = await adminAuth.verifyIdToken(token);
      (req as any).user = decodedToken;
    } catch (error) {
      console.warn('Firebase ID token verification failed');
      return res.status(401).json({ error: 'Your sign-in session is invalid. Please sign in again.' });
    }
  }
  next();
};

function getUploadUserId(req: express.Request, claimedUserId?: string): string | null {
  const verifiedUserId = (req as any).user?.uid as string | undefined;
  if (verifiedUserId) {
    if (claimedUserId && claimedUserId !== verifiedUserId) return null;
    return verifiedUserId;
  }

  if (process.env.NODE_ENV === 'production') return null;
  return 'default_user';
}

async function getUserStorageLimit(req: express.Request): Promise<number> {
  const clientLimit = Number(req.headers['x-max-bytes'] || req.body?.maxBytes);
  const verifiedUserId = (req as any).user?.uid as string | undefined;

  if (verifiedUserId && process.env.NODE_ENV === 'production') {
    try {
      const profile = await adminDb.doc(`users/${verifiedUserId}`).get();
      return profile.exists
        ? Math.max(FREE_STORAGE_BYTES, Number(profile.data()?.maxStorageBytes) || FREE_STORAGE_BYTES)
        : FREE_STORAGE_BYTES;
    } catch (error) {
      if (process.env.NODE_ENV === 'production') throw error;
      throw error;
    }
  }

  if (verifiedUserId && clientLimit > 0) return Math.max(FREE_STORAGE_BYTES, clientLimit);
  return FREE_STORAGE_BYTES;
}

async function getUserUsedBytes(req: express.Request, userId: string): Promise<number> {
  const filesById = new Map(
    serverStorage.getAllFiles(true, userId).map((file) => [file.id, Number(file.size) || 0])
  );
  const verifiedUserId = (req as any).user?.uid as string | undefined;

  if (verifiedUserId && process.env.NODE_ENV === 'production') {
    try {
      const snapshot = await adminDb.collection('users').doc(verifiedUserId).collection('files').get();
      snapshot.forEach((fileDoc) => {
        const file = fileDoc.data();
        if (!file.isFolder) filesById.set(fileDoc.id, Number(file.size) || 0);
        else filesById.delete(fileDoc.id);
      });
    } catch (error) {
      if (process.env.NODE_ENV === 'production') throw error;
      throw error;
    }
  }

  return Array.from(filesById.values()).reduce((total, size) => total + size, 0);
}

// API Routes
app.get('/api/files', authenticate, async (req, res) => {
  try {
    const category = (req.query.category as string) || 'all';
    const queryStr = ((req.query.q as string) || '').toLowerCase();
    const userId = getUploadUserId(req, req.query.userId as string | undefined);
    if (!userId) return res.status(403).json({ error: 'You can only access your own files.' });
    let files = serverStorage.getAllFiles(category === 'trash', userId);

    if (category === 'trash') files = files.filter((f) => f.isDeleted && !f.isFolder);
    else if (category === 'folders') files = files.filter((f) => f.isFolder);
    else if (category === 'apps') files = files.filter((f) => /\.(exe|msi|app|dmg|pkg|deb|rpm|apk|aab|ipa|bat|cmd|appx|msix)$/i.test(f.name));
    else if (category === 'photos') files = files.filter((f) => detectFileType(f.name, f.mimeType) === 'image');
    else if (category === 'documents') files = files.filter((f) => detectFileType(f.name, f.mimeType) === 'document' || detectFileType(f.name, f.mimeType) === 'code');
    else if (category === 'videos') files = files.filter((f) => detectFileType(f.name, f.mimeType) === 'video');
    else if (category === 'audio') files = files.filter((f) => detectFileType(f.name, f.mimeType) === 'audio');
    else if (category === 'archives') files = files.filter((f) => detectFileType(f.name, f.mimeType) === 'archive');
    else if (category === 'favorites') files = files.filter((f) => f.isFavorite);

    if (queryStr) {
      files = files.filter((f) => f.name.toLowerCase().includes(queryStr));
    }

    const maxBytes = await getUserStorageLimit(req);
    const stats = serverStorage.getStats(maxBytes, userId);

    res.json({ files, stats });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to list files' });
  }
});

// Chunked Upload: 1. Initialize
app.post('/api/upload/chunk/init', authenticate, async (req, res) => {
  try {
    const { fileName, fileSize } = req.body;
    const userId = getUploadUserId(req, req.body.userId);
    if (!userId) return res.status(403).json({ error: 'You can only upload to your own account.' });
    if (typeof fileName !== 'string' || !fileName.trim() || !Number.isSafeInteger(fileSize) || fileSize <= 0) {
      return res.status(400).json({ error: 'fileName and fileSize are required' });
    }

    if ((req as any).user?.uid && req.body.userId !== (req as any).user.uid) {
      return res.status(403).json({ error: 'Upload user does not match the signed-in account.' });
    }

    const maxBytes = await getUserStorageLimit(req);
    const usedBytes = await getUserUsedBytes(req, userId);
    if (fileSize > maxBytes || usedBytes + fileSize > maxBytes) {
      return res.status(413).json({
        error: 'This upload would exceed your storage plan limit. Please upgrade your plan or free up space.',
        code: 'STORAGE_LIMIT_EXCEEDED',
        usedBytes,
        maxBytes,
      });
    }

    const uploadId = `chk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    // S3-compatible multipart uploads support at most 10,000 parts.
    const chunkSize = Math.max(CHUNK_SIZE, Math.ceil(fileSize / 10_000 / (1024 * 1024)) * 1024 * 1024);
    const b2Multipart = await beginB2MultipartUpload(fileName, req.body.mimeType || 'application/octet-stream', userId);
    uploadSessions.set(uploadId, {
      userId,
      fileSize,
      chunkSize,
      maxBytes,
      createdAt: Date.now(),
      phase: 'receiving',
      receivedBytes: 0,
      cloudUploadedBytes: 0,
      b2Multipart,
      parts: new Map(),
      partSizes: new Map(),
      cloudBytesByPart: new Map(),
    });

    res.json({
      success: true,
      uploadId,
      chunkSize,
      message: 'Chunked upload initialized',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to initialize chunk upload' });
  }
});

app.get('/api/upload/chunk/:uploadId/status', authenticate, (req, res) => {
  const uploadId = req.params.uploadId as string;
  const session = uploadSessions.get(uploadId);
  const userId = getUploadUserId(req);
  if (!session || Date.now() - session.createdAt > 24 * 60 * 60 * 1000 || !userId || session.userId !== userId) {
    return res.status(404).json({ error: 'Upload session not found.' });
  }
  return res.json({
    phase: session.phase,
    receivedBytes: session.receivedBytes,
    fileSize: session.fileSize,
    cloudUploadedBytes: session.cloudUploadedBytes,
  });
});

app.post('/api/folders', authenticate, async (req, res) => {
  try {
    const userId = getUploadUserId(req, req.body?.userId);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!userId) return res.status(403).json({ error: 'You can only create folders in your own account.' });
    if (!name || name.length > 120) return res.status(400).json({ error: 'Folder name must be between 1 and 120 characters.' });
    if ((req as any).user?.uid && req.body.userId !== (req as any).user.uid) {
      return res.status(403).json({ error: 'Folder user does not match the signed-in account.' });
    }
    const folder = serverStorage.createFolder(name, userId, typeof req.body.folderId === 'string' ? req.body.folderId : null);
    return res.json({ success: true, folder });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Could not create folder.' });
  }
});

app.delete('/api/folders/:id', authenticate, (req, res) => {
  const verifiedUserId = (req as any).user?.uid as string | undefined;
  const requestedUserId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
  if (verifiedUserId && requestedUserId && requestedUserId !== verifiedUserId) {
    return res.status(403).json({ success: false, error: 'You can only delete folders in your own account.' });
  }
  const userId = verifiedUserId || requestedUserId || 'default_user';
  if (process.env.NODE_ENV === 'production' && !verifiedUserId) {
    return res.status(403).json({ success: false, error: 'Sign in to delete this folder.' });
  }

  const folder = serverStorage.deleteFolder(req.params.id as string, userId);
  if (!folder) return res.status(404).json({ success: false, error: 'Folder not found.' });
  return res.json({ success: true, folder, contentsMovedTo: folder.folderId || null });
});

app.get('/api/folders', authenticate, (req, res) => {
  const userId = getUploadUserId(req, typeof req.query.userId === 'string' ? req.query.userId : undefined);
  if (!userId) return res.status(403).json({ error: 'You can only view folders in your own account.' });
  return res.json({ folders: serverStorage.getFolders(userId) });
});

// Chunked Upload: 2. Sign a B2 part URL; the browser sends the file bytes directly to B2.
app.post('/api/upload/chunk/url', authenticate, async (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.body;
    const session = typeof uploadId === 'string' ? uploadSessions.get(uploadId) : undefined;
    const userId = getUploadUserId(req);
    const index = Number(chunkIndex);
    const totalChunks = session ? Math.ceil(session.fileSize / session.chunkSize) : 0;
    if (!session || session.userId !== userId || !Number.isInteger(index) || index < 0 || index >= totalChunks) {
      return res.status(404).json({ error: 'Upload session not found or expired.' });
    }
    const uploadUrl = await createB2MultipartPartUrl(session.b2Multipart, index + 1);
    return res.json({ uploadUrl, partNumber: index + 1 });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Could not prepare the upload part.' });
  }
});

// Chunked Upload: 3. Record the ETag returned by B2 after a direct browser upload.
app.post('/api/upload/chunk/part-complete', authenticate, (req, res) => {
  const { uploadId, chunkIndex, eTag } = req.body;
  const session = typeof uploadId === 'string' ? uploadSessions.get(uploadId) : undefined;
  const userId = getUploadUserId(req);
  const index = Number(chunkIndex);
  const totalChunks = session ? Math.ceil(session.fileSize / session.chunkSize) : 0;
  if (!session || session.userId !== userId || !Number.isInteger(index) || index < 0 || index >= totalChunks || typeof eTag !== 'string' || !eTag) {
    return res.status(400).json({ error: 'Invalid uploaded part.' });
  }
  const size = Math.min(session.chunkSize, session.fileSize - index * session.chunkSize);
  session.parts.set(index, { ETag: eTag, PartNumber: index + 1 });
  session.partSizes.set(index, size);
  session.receivedBytes = Array.from(session.partSizes.values()).reduce((sum, value) => sum + value, 0);
  session.cloudUploadedBytes = session.receivedBytes;
  return res.json({ success: true });
});

// Chunked Upload: 3. Complete the already-streamed cloud multipart upload
app.post('/api/upload/chunk/complete', authenticate, async (req, res) => {
  try {
    const { uploadId, fileName, mimeType, totalChunks } = req.body;
    const userId = getUploadUserId(req, req.body.userId);
    if (!userId) return res.status(403).json({ error: 'You can only upload to your own account.' });
    if (!uploadId || typeof fileName !== 'string' || !fileName.trim()) {
      return res.status(400).json({ error: 'uploadId and fileName are required' });
    }

    const session = uploadSessions.get(uploadId);
    if (!/^chk_[0-9]+_[a-z0-9]+$/.test(uploadId) || !session || session.userId !== userId) {
      return res.status(404).json({ error: 'Upload session not found' });
    }

    const expectedChunks = Math.ceil(session.fileSize / session.chunkSize);
    if (Number(totalChunks) !== expectedChunks || session.parts.size !== expectedChunks || session.receivedBytes !== session.fileSize) {
      return res.status(400).json({
        error: `Incomplete cloud upload: received ${session.parts.size} of ${expectedChunks} parts.`,
      });
    }

    const finalFileSize = session.fileSize;
    const usedBytes = await getUserUsedBytes(req, userId);
    if (usedBytes + finalFileSize > session.maxBytes) {
      await abortB2MultipartUpload(session.b2Multipart).catch(() => {});
      uploadSessions.delete(uploadId);
      return res.status(413).json({
        error: 'This upload would exceed your storage plan limit. Please free up space and try again.',
        code: 'STORAGE_LIMIT_EXCEEDED',
        usedBytes,
        maxBytes: session.maxBytes,
      });
    }

    const resolvedMimeType = resolveMimeType(fileName, mimeType || 'application/octet-stream');
    let b2Result;
    try {
      b2Result = await completeB2MultipartUpload(
        session.b2Multipart,
        Array.from(session.parts.values()).sort((a, b) => a.PartNumber - b.PartNumber),
        finalFileSize
      );
    } catch (b2Error: any) {
      uploadSessions.delete(uploadId);
      console.error('Cloud multipart completion failed:', b2Error);
      return res.status(502).json({
        error: `Cloud upload could not be completed: ${b2Error?.message || 'please retry the upload'}`,
        code: 'CLOUD_UPLOAD_FAILED',
      });
    }

    session.phase = 'finalizing';
    const saved = serverStorage.saveRemoteFileMetadata(
      fileName,
      finalFileSize,
      resolvedMimeType,
      {
        userId,
        b2FileId: b2Result.b2FileId,
        b2FileName: b2Result.b2FileName,
        b2BucketName: b2Result.b2BucketName,
        storedInB2: true,
      }
    );
    saved.url = `/api/files/${saved.id}?userId=${encodeURIComponent(userId)}&b2FileName=${encodeURIComponent(b2Result.b2FileName)}`;

    const stats = serverStorage.getStats(session.maxBytes, userId);
    session.phase = 'complete';
    const cleanupTimer = setTimeout(() => uploadSessions.delete(uploadId), 10 * 60 * 1000);
    cleanupTimer.unref?.();
    res.json({
      success: true,
      message: `Successfully uploaded ${fileName}`,
      file: saved,
      files: [saved],
      stats,
    });
  } catch (err: any) {
    const uploadId = req.body?.uploadId;
    const session = typeof uploadId === 'string' ? uploadSessions.get(uploadId) : undefined;
    if (session) {
      session.phase = 'error';
      const cleanupTimer = setTimeout(() => uploadSessions.delete(uploadId), 10 * 60 * 1000);
      cleanupTimer.unref?.();
    }
    res.status(500).json({ error: err.message || 'Failed to complete chunked upload' });
  }
});

// Stream File with HTTP 206 Range support for video preview and playback
app.get('/api/files/:id', async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req.query.userId as string) || undefined;
    const b2FileName = (req.query.b2FileName as string) || undefined;
    const { meta, diskPath } = serverStorage.getFile(id);

    const download = req.query.download === 'true';
    const fileName = meta?.name || (b2FileName ? path.basename(b2FileName) : id);
    const mimeType = meta?.mimeType || 'application/octet-stream';

    // Stream directly from disk with Range support for video scrubbing & instant previews
    if (diskPath && fs.existsSync(diskPath)) {
      const stat = fs.statSync(diskPath);
      const totalSize = stat.size;
      const range = req.headers.range;

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (download) {
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      } else {
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
      }

      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
          return;
        }

        let start = match[1] ? Number(match[1]) : Math.max(0, totalSize - Number(match[2]));
        let end = match[2] && match[1] ? Number(match[2]) : totalSize - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= totalSize || end >= totalSize || start > end) {
          res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
          return;
        }

        const chunkSize = (end - start) + 1;
        const fileStream = fs.createReadStream(diskPath, { start, end });
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mimeType,
        });
        fileStream.pipe(res);
        return;
      }

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', totalSize.toString());
      fs.createReadStream(diskPath).pipe(res);
      return;
    }

    // Stream from B2, including partial byte ranges used by video players.
    const objectKey = b2FileName || meta?.b2FileName;
    if (objectKey) {
      const b2Object = await openFileFromB2(objectKey, userId || meta?.userId, req.headers.range);
      if (b2Object) {
        res.setHeader('Accept-Ranges', b2Object.acceptRanges || 'bytes');
        res.setHeader('Content-Type', b2Object.contentType || mimeType);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        if (b2Object.contentLength !== undefined) res.setHeader('Content-Length', String(b2Object.contentLength));
        if (b2Object.contentRange) res.setHeader('Content-Range', b2Object.contentRange);
        res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(fileName)}"`);
        res.status(b2Object.contentRange ? 206 : 200);
        b2Object.body.pipe(res);
        return;
      }
    }

    const local = serverStorage.getFile(id);
    const buffer = local.buffer;

    if (!buffer) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', buffer.length.toString());
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
    }
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve file' });
  }
});

app.patch('/api/files/:id', authenticate, (req, res) => {
  try {
    const id = req.params.id as string;
    const body = req.body;

    if (typeof body.newName === 'string') {
      const updated = serverStorage.renameFile(id, body.newName);
      if (!updated) return res.status(404).json({ error: 'File not found' });
      return res.json({ success: true, file: updated });
    }

    if (typeof body.isFavorite === 'boolean') {
      const updated = serverStorage.toggleFavorite(id, body.isFavorite);
      if (!updated) return res.status(404).json({ error: 'File not found' });
      return res.json({ success: true, file: updated });
    }

    if (Object.prototype.hasOwnProperty.call(body, 'folderId')) {
      const updated = serverStorage.moveFileToFolder(id, body.folderId || null);
      if (!updated) return res.status(404).json({ error: 'File not found' });
      return res.json({ success: true, file: updated });
    }

    if (body.action === 'restore') {
      const verifiedUserId = (req as any).user?.uid as string | undefined;
      const file = serverStorage.getFile(id).meta;
      if (process.env.NODE_ENV === 'production' && !verifiedUserId) {
        return res.status(403).json({ success: false, error: 'Sign in to restore this file.' });
      }
      if (verifiedUserId && file && (file.userId || 'default_user') !== verifiedUserId) {
        return res.status(403).json({ success: false, error: 'You can only restore your own files.' });
      }
      const ok = serverStorage.restoreFile(id);
      return res.json({ success: ok });
    }

    res.status(400).json({ error: 'Invalid update payload' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update file' });
  }
});

app.delete('/api/files/:id', authenticate, async (req, res) => {
  const id = req.params.id as string;
  const userId = (req as any).user?.uid || (req.query.userId as string) || (req.body?.userId as string) || 'default_user';
  const queryB2FileName = typeof req.query.b2FileName === 'string' ? req.query.b2FileName : undefined;
  const localFile = serverStorage.getFile(id)?.meta;
  const b2ObjectKey = queryB2FileName || localFile?.b2FileName;
  const failures: string[] = [];
  let b2Deleted = false;

  if ((req as any).user?.uid && req.query.userId && req.query.userId !== (req as any).user.uid) {
    return res.status(403).json({ success: false, error: 'You can only delete your own files.' });
  }
  if (process.env.NODE_ENV === 'production' && !(req as any).user?.uid) {
    return res.status(403).json({ success: false, error: 'Sign in to delete this file.' });
  }

  if (req.query.permanent !== 'true') {
    const deletedAt = new Date().toISOString();
    if (process.env.NODE_ENV === 'production') {
      try {
        const userFileRef = adminDb.doc(`users/${userId}/files/${id}`);
        const rootFileRef = adminDb.doc(`files/${id}`);
        const userFile = await userFileRef.get();
        if (!userFile.exists || userFile.data()?.userId !== userId) {
          return res.status(404).json({ success: false, error: 'File not found in this account.' });
        }
        await userFileRef.update({ isDeleted: true, deletedAt, updatedAt: deletedAt });
        const rootFile = await rootFileRef.get();
        if (rootFile.exists && rootFile.data()?.userId === userId) {
          await rootFileRef.update({ isDeleted: true, deletedAt, updatedAt: deletedAt });
        }
      } catch (err: any) {
        return res.status(500).json({ success: false, error: err?.message || 'Could not move file to Trash.' });
      }
    }
    if (localFile) serverStorage.deleteFile(id, false);
    return res.json({ success: true, trashed: true, deletedAt, retentionDays: 30 });
  }

  console.log(`[DELETE] Starting permanent deletion: id=${id}, user=${userId}`);

  // Use the explicit key even when the local cache has no record, as happens
  // with Firebase-backed files and after a server restart.
  if (!b2ObjectKey && (localFile?.storedInB2 || req.query.storedInB2 === 'true')) {
    failures.push('Backblaze object key is missing; cloud file was left untouched');
  } else if (b2ObjectKey && !isB2Configured()) {
    failures.push('Backblaze B2 is not configured on the server');
  } else if (b2ObjectKey) {
    try {
      b2Deleted = await permanentlyDeleteB2File(b2ObjectKey, userId);
      if (!b2Deleted) failures.push('No matching Backblaze object versions were found; cloud file was not confirmed deleted');
    } catch (err: any) {
      failures.push(`Backblaze B2: ${err?.message || 'deletion failed'}`);
    }
  }

  // Admin credentials are required in production; local development relies on
  // the signed-in browser's Firestore SDK to remove both records.
  if (process.env.NODE_ENV === 'production') {
    try {
      await Promise.all([
        adminDb.doc(`users/${userId}/files/${id}`).delete(),
        adminDb.doc(`files/${id}`).delete(),
      ]);
    } catch (err: any) {
      failures.push(`Firebase: ${err?.message || 'metadata deletion failed'}`);
    }
  }

  try {
    if (localFile) serverStorage.deleteFile(id, true);
  } catch (err: any) {
    failures.push(`Local file cache: ${err?.message || 'deletion failed'}`);
  }

  const complete = failures.length === 0;
  return res.status(complete ? 200 : 207).json({
    success: complete,
    b2Configured: isB2Configured(),
    b2Deleted,
    failures,
    message: complete ? `File ${id} permanently deleted.` : `File ${id} was only partially deleted.`,
  });
});

// Verification Code Endpoints for Email Sign-Up and Password Reset
const verificationCodes = new Map<string, { code: string; expiresAt: number; name?: string; type: 'signup' | 'reset' }>();

app.post('/api/auth/send-verification-code', (req, res) => {
  try {
    const { email, name, type = 'signup' } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    verificationCodes.set(cleanEmail, { code, expiresAt, name, type });
    console.log(`[AUTH VERIFICATION] Code for ${cleanEmail} (${type}): ${code}`);

    res.json({
      success: true,
      message: `Verification code sent to ${cleanEmail}`,
      code,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to send verification code' });
  }
});

app.post('/api/auth/verify-code', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and verification code are required' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const stored = verificationCodes.get(cleanEmail);

    if (!stored) {
      return res.status(400).json({ error: 'No verification code found for this email. Please request a new code.' });
    }

    if (Date.now() > stored.expiresAt) {
      verificationCodes.delete(cleanEmail);
      return res.status(400).json({ error: 'Verification code has expired. Please request a new code.' });
    }

    if (stored.code !== code.toString().trim()) {
      return res.status(400).json({ error: 'Invalid 6-digit verification code. Please check and try again.' });
    }

    verificationCodes.delete(cleanEmail);
    res.json({ success: true, message: 'Email code verified successfully!' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to verify code' });
  }
});

// Serve Vite Frontend
async function setupVite() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(vite.middlewares);
    app.use(/.*/, async (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      try {
        const url = req.originalUrl;
        let template = fs.readFileSync(path.resolve('./index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e: any) {
        vite.ssrFixStacktrace(e);
        next(e);
      }
    });
  } else {
    app.use(express.static(path.resolve('./dist')));
    app.use(/.*/, (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.resolve('./dist/index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cloudvalt server running on http://0.0.0.0:${PORT}`);
  });
}

setupVite();
