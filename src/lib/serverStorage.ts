import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { CloudFile, FileType, StorageStats } from './types';

const STORE_DIR = '/tmp/cloudvalt_store';
const FILES_DIR = path.join(STORE_DIR, 'files');
const MANIFEST_FILE = path.join(STORE_DIR, 'manifest.json');

// Ensure directories exist
if (!fs.existsSync(STORE_DIR)) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}
if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

export function detectFileType(fileName: string, mimeType: string = ''): FileType {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const mime = mimeType.toLowerCase();

  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'heic', 'heif'].includes(ext) || mime.startsWith('image/')) {
    return 'image';
  }
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', '3gp', 'flv'].includes(ext) || mime.startsWith('video/')) {
    return 'video';
  }
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus'].includes(ext) || mime.startsWith('audio/')) {
    return 'audio';
  }
  if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'csv', 'xls', 'xlsx', 'ppt', 'pptx', 'md'].includes(ext) || mime.includes('pdf') || mime.includes('word') || mime.includes('text')) {
    return 'document';
  }
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) {
    return 'archive';
  }
  if (['js', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'py', 'go', 'rs', 'c', 'cpp'].includes(ext)) {
    return 'code';
  }
  return 'other';
}

function getInitialDemoFiles(): CloudFile[] {
  return [];
}

function readManifest(): CloudFile[] {
  try {
    if (fs.existsSync(MANIFEST_FILE)) {
      const raw = fs.readFileSync(MANIFEST_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('Error reading manifest:', err);
  }
  return [];
}

function writeManifest(files: CloudFile[]) {
  try {
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(files, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing manifest:', err);
  }
}

const CHUNKS_DIR = path.join(STORE_DIR, 'chunks');
if (!fs.existsSync(CHUNKS_DIR)) {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
}

export { STORE_DIR, FILES_DIR, CHUNKS_DIR };

export const serverStorage = {
  getAllFiles(includeDeleted = false, userId?: string): CloudFile[] {
    const all = readManifest();
    return all.filter((f) => {
      const matchesDeleted = includeDeleted ? f.isDeleted : !f.isDeleted;
      if (!matchesDeleted) return false;
      if (userId && userId !== 'default_user') {
        return f.userId === userId || !f.userId;
      }
      return true;
    });
  },

  getFile(id: string): { meta?: CloudFile; buffer?: Buffer; diskPath?: string; size?: number } {
    const all = readManifest();
    const meta = all.find((f) => f.id === id);
    if (!meta) return {};

    const filePath = path.join(FILES_DIR, id);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      return { meta, diskPath: filePath, size: stats.size };
    }

    // Fallback dummy buffer for seeded demo files
    return {
      meta,
      buffer: Buffer.from(`CloudValt sample content for ${meta.name}`),
      size: meta.size || 0,
    };
  },

  async saveFile(
    name: string,
    buffer: Buffer,
    mimeType: string,
    extra?: Partial<CloudFile>
  ): Promise<CloudFile> {
    const id = `file_${Date.now()}_${uuidv4().substring(0, 6)}`;
    const diskPath = path.join(FILES_DIR, id);
    fs.writeFileSync(diskPath, buffer);

    const type = detectFileType(name, mimeType);
    const now = new Date().toISOString();

    let contentBase64: string | undefined;
    if (type === 'image' && buffer.length < 5 * 1024 * 1024) {
      contentBase64 = `data:${mimeType || 'image/png'};base64,${buffer.toString('base64')}`;
    }

    const newFile: CloudFile = {
      id,
      name,
      size: buffer.length,
      type,
      mimeType: mimeType || 'application/octet-stream',
      uploadedAt: now,
      updatedAt: now,
      isFavorite: false,
      isDeleted: false,
      contentBase64,
      url: `/api/files/${id}`,
      storagePath: diskPath,
      b2FileId: extra?.b2FileId,
      b2FileName: extra?.b2FileName,
      b2BucketName: extra?.b2BucketName,
      userId: extra?.userId,
      storedInB2: extra?.storedInB2,
      ...extra,
    };

    const all = readManifest();
    all.unshift(newFile);
    writeManifest(all);
    return newFile;
  },

  async saveFileFromDisk(
    name: string,
    tempFilePath: string,
    fileSize: number,
    mimeType: string,
    extra?: Partial<CloudFile>
  ): Promise<CloudFile> {
    const id = `file_${Date.now()}_${uuidv4().substring(0, 6)}`;
    const diskPath = path.join(FILES_DIR, id);

    // Fast move from temp to permanent files directory
    try {
      fs.renameSync(tempFilePath, diskPath);
    } catch {
      // Fallback copy if cross-device link
      fs.copyFileSync(tempFilePath, diskPath);
      try { fs.unlinkSync(tempFilePath); } catch {}
    }

    const type = detectFileType(name, mimeType);
    const now = new Date().toISOString();

    let contentBase64: string | undefined;
    if (type === 'image' && fileSize < 5 * 1024 * 1024) {
      try {
        const buf = fs.readFileSync(diskPath);
        contentBase64 = `data:${mimeType || 'image/png'};base64,${buf.toString('base64')}`;
      } catch {}
    }

    const newFile: CloudFile = {
      id,
      name,
      size: fileSize,
      type,
      mimeType: mimeType || 'application/octet-stream',
      uploadedAt: now,
      updatedAt: now,
      isFavorite: false,
      isDeleted: false,
      contentBase64,
      url: `/api/files/${id}`,
      storagePath: diskPath,
      b2FileId: extra?.b2FileId,
      b2FileName: extra?.b2FileName,
      b2BucketName: extra?.b2BucketName,
      userId: extra?.userId,
      storedInB2: extra?.storedInB2,
      ...extra,
    };

    const all = readManifest();
    all.unshift(newFile);
    writeManifest(all);
    return newFile;
  },

  deleteFile(id: string, permanent = true): boolean {
    const all = readManifest();
    const idx = all.findIndex((f) => f.id === id);
    if (idx === -1) return false;

    // Direct permanent deletion (Trash removed)
    all.splice(idx, 1);
    const filePath = path.join(FILES_DIR, id);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }

    writeManifest(all);
    return true;
  },

  restoreFile(id: string): boolean {
    const all = readManifest();
    const file = all.find((f) => f.id === id);
    if (file) {
      file.isDeleted = false;
      file.updatedAt = new Date().toISOString();
      writeManifest(all);
      return true;
    }
    return false;
  },

  renameFile(id: string, newName: string): CloudFile | null {
    const all = readManifest();
    const file = all.find((f) => f.id === id);
    if (file) {
      file.name = newName.trim();
      file.type = detectFileType(file.name, file.mimeType);
      file.updatedAt = new Date().toISOString();
      writeManifest(all);
      return file;
    }
    return null;
  },

  toggleFavorite(id: string, isFavorite?: boolean): CloudFile | null {
    const all = readManifest();
    const file = all.find((f) => f.id === id);
    if (file) {
      file.isFavorite = typeof isFavorite === 'boolean' ? isFavorite : !file.isFavorite;
      file.updatedAt = new Date().toISOString();
      writeManifest(all);
      return file;
    }
    return null;
  },

  getStats(customMaxBytes?: number, userId?: string): StorageStats {
    let all = readManifest().filter((f) => !f.isDeleted);
    if (userId && userId !== 'default_user') {
      all = all.filter((f) => f.userId === userId || !f.userId);
    }
    const maxBytes = customMaxBytes || 100 * 1024 * 1024; // 100 MB Free (Test Mode)
    let usedBytes = 0;
    let favoriteCount = 0;

    const categoryBreakdown: Record<FileType, { count: number; bytes: number }> = {
      image: { count: 0, bytes: 0 },
      document: { count: 0, bytes: 0 },
      video: { count: 0, bytes: 0 },
      audio: { count: 0, bytes: 0 },
      archive: { count: 0, bytes: 0 },
      code: { count: 0, bytes: 0 },
      other: { count: 0, bytes: 0 },
    };

    for (const file of all) {
      usedBytes += file.size;
      if (file.isFavorite) favoriteCount++;
      if (categoryBreakdown[file.type]) {
        categoryBreakdown[file.type].count++;
        categoryBreakdown[file.type].bytes += file.size;
      } else {
        categoryBreakdown.other.count++;
        categoryBreakdown.other.bytes += file.size;
      }
    }

    return {
      usedBytes,
      maxBytes,
      totalFiles: all.length,
      categoryBreakdown,
      favoriteCount,
    };
  },
};
