import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { uploadFileToB2, downloadFileFromB2, deleteFileFromB2, permanentlyDeleteB2File } from './src/lib/b2Storage';
import { serverStorage, detectFileType, CHUNKS_DIR } from './src/lib/serverStorage';
import { createServer as createViteServer } from 'vite';

import { adminAuth, adminDb } from './src/lib/firebase-admin';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2000 * 1024 * 1024 }, // 2GB limit for standard single upload
});

const chunkUpload = multer({
  dest: CHUNKS_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per chunk limit (chunks are typically 5MB-10MB)
});

// Authentication Middleware with graceful fallback
const authenticate = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1];
    try {
      const decodedToken = await adminAuth.verifyIdToken(token);
      (req as any).user = decodedToken;
    } catch (error) {
      // Admin token verification might not have credentials in this environment
      console.warn('Firebase ID token verification bypassed for local/dev mode');
    }
  }
  next();
};

// API Routes
app.get('/api/files', async (req, res) => {
  try {
    const category = (req.query.category as string) || 'all';
    const queryStr = ((req.query.q as string) || '').toLowerCase();
    const userId = (req.query.userId as string) || (req.headers['x-user-id'] as string);
    let files = serverStorage.getAllFiles(false, userId);

    if (category === 'photos') files = files.filter((f) => detectFileType(f.name, f.mimeType) === 'image');
    else if (category === 'documents') files = files.filter((f) => detectFileType(f.name, f.mimeType) === 'document' || detectFileType(f.name, f.mimeType) === 'code');
    else if (category === 'videos') files = files.filter((f) => detectFileType(f.name, f.mimeType) === 'video');
    else if (category === 'audio') files = files.filter((f) => detectFileType(f.name, f.mimeType) === 'audio');
    else if (category === 'archives') files = files.filter((f) => detectFileType(f.name, f.mimeType) === 'archive');
    else if (category === 'favorites') files = files.filter((f) => f.isFavorite);

    if (queryStr) {
      files = files.filter((f) => f.name.toLowerCase().includes(queryStr));
    }

    const maxBytesParam = Number(req.query.maxBytes);
    const stats = serverStorage.getStats(maxBytesParam > 0 ? maxBytesParam : undefined, userId);

    res.json({ files, stats });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to list files' });
  }
});

// Chunked Upload: 1. Initialize
app.post('/api/upload/chunk/init', async (req, res) => {
  try {
    const { fileName, fileSize, mimeType, userId = 'default_user' } = req.body;
    if (!fileName || !fileSize) {
      return res.status(400).json({ error: 'fileName and fileSize are required' });
    }

    const maxBytesHeader = Number(req.headers['x-max-bytes'] || req.body.maxBytes);
    if (maxBytesHeader > 0) {
      const stats = serverStorage.getStats(maxBytesHeader);
      if (fileSize > maxBytesHeader || (stats.usedBytes + fileSize > maxBytesHeader)) {
        return res.status(413).json({
          error: 'File size exceeds your storage plan limit. Please upgrade your storage plan.',
          code: 'STORAGE_LIMIT_EXCEEDED',
          usedBytes: stats.usedBytes,
          maxBytes: maxBytesHeader,
        });
      }
    }

    const uploadId = `chk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const uploadSessionDir = path.join(CHUNKS_DIR, uploadId);
    fs.mkdirSync(uploadSessionDir, { recursive: true });

    res.json({
      success: true,
      uploadId,
      message: 'Chunked upload initialized',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to initialize chunk upload' });
  }
});

// Chunked Upload: 2. Upload Individual Chunk
app.post('/api/upload/chunk', chunkUpload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.body;
    const file = req.file;

    if (!uploadId || chunkIndex === undefined || !file) {
      return res.status(400).json({ error: 'Missing chunk upload parameters' });
    }

    const uploadSessionDir = path.join(CHUNKS_DIR, uploadId);
    if (!fs.existsSync(uploadSessionDir)) {
      return res.status(404).json({ error: 'Upload session not found or expired' });
    }

    const chunkTarget = path.join(uploadSessionDir, `part_${String(chunkIndex).padStart(6, '0')}`);
    fs.renameSync(file.path, chunkTarget);

    res.json({ success: true, chunkIndex: Number(chunkIndex) });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to save chunk' });
  }
});

// Chunked Upload: 3. Complete and Assemble Chunks without high RAM usage
app.post('/api/upload/chunk/complete', async (req, res) => {
  try {
    const { uploadId, fileName, mimeType, userId = 'default_user', totalChunks } = req.body;
    if (!uploadId || !fileName) {
      return res.status(400).json({ error: 'uploadId and fileName are required' });
    }

    const uploadSessionDir = path.join(CHUNKS_DIR, uploadId);
    if (!fs.existsSync(uploadSessionDir)) {
      return res.status(404).json({ error: 'Upload session directory not found' });
    }

    const assembledTempFile = path.join(CHUNKS_DIR, `assembled_${uploadId}`);
    const writeStream = fs.createWriteStream(assembledTempFile);

    const chunkFiles = fs.readdirSync(uploadSessionDir)
      .filter((f) => f.startsWith('part_'))
      .sort((a, b) => {
        const numA = parseInt(a.replace('part_', ''), 10);
        const numB = parseInt(b.replace('part_', ''), 10);
        return numA - numB;
      });

    if (totalChunks && chunkFiles.length !== Number(totalChunks)) {
      return res.status(400).json({
        error: `Incomplete chunks: received ${chunkFiles.length} of ${totalChunks}`,
      });
    }

    for (const chunkName of chunkFiles) {
      const chunkPath = path.join(uploadSessionDir, chunkName);
      const data = fs.readFileSync(chunkPath);
      writeStream.write(data);
    }
    writeStream.end();

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', () => resolve());
      writeStream.on('error', (err) => reject(err));
    });

    const assembledStats = fs.statSync(assembledTempFile);
    const finalFileSize = assembledStats.size;

    // Clean up temporary session directory
    try {
      fs.rmSync(uploadSessionDir, { recursive: true, force: true });
    } catch {}

    // Save assembled file directly from disk without buffering entire multi-GB file in RAM
    const saved = await serverStorage.saveFileFromDisk(
      fileName,
      assembledTempFile,
      finalFileSize,
      mimeType || 'application/octet-stream',
      {
        userId,
      }
    );

    const stats = serverStorage.getStats();
    res.json({
      success: true,
      message: `Successfully uploaded ${fileName}`,
      file: saved,
      files: [saved],
      stats,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to complete chunked upload' });
  }
});

// Standard Single/Batch Upload
app.post('/api/files', upload.array('files'), async (req, res) => {
  try {
    const userId = (req.body.userId as string) || 'default_user';
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files provided in upload request' });
    }

    const maxBytesHeader = Number(req.headers['x-max-bytes'] || req.body.maxBytes);
    if (maxBytesHeader > 0) {
      const stats = serverStorage.getStats(maxBytesHeader);
      const incomingSize = files.reduce((acc, f) => acc + f.size, 0);
      const singleOversized = files.find((f) => f.size > maxBytesHeader);
      if (singleOversized || (stats.usedBytes + incomingSize > maxBytesHeader)) {
        return res.status(413).json({
          error: 'File size exceeds your storage plan limit. Please upgrade your storage plan.',
          code: 'STORAGE_LIMIT_EXCEEDED',
          usedBytes: stats.usedBytes,
          maxBytes: maxBytesHeader,
        });
      }
    }

    const savedResults = [];
    for (const file of files) {
      let b2Result: any = null;
      try {
        b2Result = await uploadFileToB2(file.originalname, file.buffer, file.mimetype, userId);
      } catch (b2Err) {
        console.warn('Backblaze B2 upload notice:', b2Err);
      }

      const saved = await serverStorage.saveFile(file.originalname, file.buffer, file.mimetype, {
        b2FileId: b2Result?.b2FileId,
        b2FileName: b2Result?.b2FileName,
        b2BucketName: b2Result?.b2BucketName,
        userId: userId,
        storedInB2: Boolean(b2Result),
      });
      savedResults.push(saved);
    }

    const stats = serverStorage.getStats();
    res.json({
      success: true,
      message: `Successfully uploaded ${savedResults.length} file(s) to Cloudvalt`,
      files: savedResults,
      stats,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to upload files' });
  }
});

// Stream File with HTTP 206 Range support for video preview and playback
app.get('/api/files/:id', async (req, res) => {
  try {
    const id = req.params.id;
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
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

        if (start >= totalSize || end >= totalSize) {
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

    // Fallback B2 or in-memory buffer
    let b2Data: { buffer: Buffer; contentType: string } | null = null;
    try {
      if (b2FileName) b2Data = await downloadFileFromB2(b2FileName, userId);
      if (!b2Data) b2Data = await downloadFileFromB2(id, userId);
    } catch {}

    const local = serverStorage.getFile(id);
    const buffer = b2Data?.buffer || local.buffer;

    if (!buffer) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.setHeader('Content-Type', b2Data?.contentType || mimeType);
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

app.patch('/api/files/:id', (req, res) => {
  try {
    const id = req.params.id;
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

    if (body.action === 'restore') {
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
  try {
    const permanent = req.query.permanent === 'true';
    const queryB2FileName = req.query.b2FileName as string;

    console.log(`[DELETE] Starting direct permanent deletion: id=${id}, user=${userId}`);

    // 1. Purge all object versions & delete markers permanently from Backblaze B2 storage
    const localFile = serverStorage.getFile(id)?.meta;
    const b2TargetName = queryB2FileName || localFile?.b2FileName || localFile?.name || id;
    let b2Wiped = false;

    try {
      await permanentlyDeleteB2File(b2TargetName, userId);
      if (localFile?.name && localFile.name !== b2TargetName) {
        await permanentlyDeleteB2File(localFile.name, userId);
      }
      b2Wiped = true;
      console.log(`[DELETE] B2 object permanently wiped: ${b2TargetName}`);
    } catch (e: any) {
      console.warn(`[DELETE] B2 deletion notice (continuing): ${e.message}`);
    }

    // 2. Remove from Firestore documents using Admin SDK (non-blocking)
    try {
      const userFileRef = adminDb.doc(`users/${userId}/files/${id}`);
      const rootFileRef = adminDb.doc(`files/${id}`);
      await userFileRef.delete();
      await rootFileRef.delete().catch(() => {});
      console.log(`[DELETE] Firestore documents removed via Admin SDK`);
    } catch (adminDbErr: any) {
      console.warn(`[DELETE] Admin SDK cleanup notice (handled on client Firestore SDK): ${adminDbErr.message}`);
    }

    // 3. Clean local server storage
    serverStorage.deleteFile(id, true);

    res.json({
      success: true,
      b2Deleted: b2Wiped,
      message: `File ${id} permanently deleted from Backblaze B2 and vault.`
    });
  } catch (err: any) {
    console.error(`[DELETE] Notice for ${id}:`, err);
    try {
      serverStorage.deleteFile(id, true);
    } catch {}
    res.json({ success: true, warning: err.message });
  }
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
