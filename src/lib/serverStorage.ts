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

export function resolveMimeType(fileName: string, mimeType: string = ''): string {
  if (mimeType && mimeType !== 'application/octet-stream') return mimeType;

  const extension = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif',
    '.heic': 'image/heic', '.heif': 'image/heif', '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.ogv': 'video/ogg',
    '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.pdf': 'application/pdf',
  };

  return mimeTypes[extension] || mimeType || 'application/octet-stream';
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
      const matchesDeleted = includeDeleted || !f.isDeleted;
      if (!matchesDeleted) return false;
      return userId ? (f.userId || 'default_user') === userId : false;
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
    mimeType = resolveMimeType(name, mimeType);
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
    mimeType = resolveMimeType(name, mimeType);
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

  saveRemoteFileMetadata(
    name: string,
    fileSize: number,
    mimeType: string,
    extra: Partial<CloudFile>
  ): CloudFile {
    const resolvedMimeType = resolveMimeType(name, mimeType);
    const now = new Date().toISOString();
    const id = `file_${Date.now()}_${uuidv4().substring(0, 6)}`;
    const newFile: CloudFile = {
      id,
      name,
      size: fileSize,
      type: detectFileType(name, resolvedMimeType),
      mimeType: resolvedMimeType,
      uploadedAt: now,
      updatedAt: now,
      isFavorite: false,
      isDeleted: false,
      url: `/api/files/${id}`,
      ...extra,
    };
    const all = readManifest();
    all.unshift(newFile);
    writeManifest(all);
    return newFile;
  },

  deleteFile(id: string, permanent = false): boolean {
    const all = readManifest();
    const idx = all.findIndex((f) => f.id === id);
    if (idx === -1) return false;

    if (!permanent) {
      all[idx].isDeleted = true;
      all[idx].deletedAt = new Date().toISOString();
      all[idx].updatedAt = all[idx].deletedAt;
    } else {
      all.splice(idx, 1);
      const filePath = path.join(FILES_DIR, id);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }

    writeManifest(all);
    return true;
  },

  restoreFile(id: string): boolean {
    const all = readManifest();
    const file = all.find((f) => f.id === id);
    if (file) {
      file.isDeleted = false;
      file.deletedAt = null;
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

  moveFileToFolder(id: string, folderId: string | null): CloudFile | null {
    const all = readManifest();
    const file = all.find((entry) => entry.id === id);
    if (!file) return null;
    file.folderId = folderId;
    file.updatedAt = new Date().toISOString();
    writeManifest(all);
    return file;
  },

  deleteFolder(id: string, userId: string): CloudFile | null {
    const all = readManifest();
    const folder = all.find((entry) => entry.id === id && entry.isFolder && (entry.userId || 'default_user') === userId);
    if (!folder) return null;

    for (const child of all) {
      if (child.folderId === id && (child.userId || 'default_user') === userId) {
        child.folderId = folder.folderId || null;
        child.updatedAt = new Date().toISOString();
      }
    }

    writeManifest(all.filter((entry) => entry.id !== id));
    return folder;
  },

  createFolder(name: string, userId: string, folderId: string | null = null): CloudFile {
    const folder: CloudFile = {
      id: `folder_${uuidv4()}`,
      name,
      size: 0,
      type: 'other',
      mimeType: 'application/x-directory',
      uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isFavorite: false,
      isFolder: true,
      folderId,
      userId,
      storedInB2: false,
    };
    const all = readManifest();
    all.unshift(folder);
    writeManifest(all);
    return folder;
  },

  getFolders(userId: string): CloudFile[] {
    const all = readManifest().filter((entry) => entry.isFolder && (entry.userId || 'default_user') === userId);
    const files = readManifest().filter((entry) => !entry.isFolder && !entry.isDeleted && (entry.userId || 'default_user') === userId);
    const sizes = new Map(all.map((folder) => [folder.id, 0]));
    for (const file of files) {
      let parentId = file.folderId || null;
      const visited = new Set<string>();
      while (parentId && !visited.has(parentId) && sizes.has(parentId)) {
        visited.add(parentId);
        sizes.set(parentId, (sizes.get(parentId) || 0) + (Number(file.size) || 0));
        parentId = all.find((folder) => folder.id === parentId)?.folderId || null;
      }
    }
    return all.map((folder) => ({ ...folder, size: sizes.get(folder.id) || 0 }));
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
    const storedFiles = readManifest().filter((f) => !f.isFolder && (userId ? (f.userId || 'default_user') === userId : false));
    const activeFiles = storedFiles.filter((f) => !f.isDeleted);
    const maxBytes = customMaxBytes || 100 * 1024 * 1024; // 100 MB Free (Test Mode)
    const usedBytes = storedFiles.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
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

    for (const file of activeFiles) {
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
      totalFiles: activeFiles.length,
      categoryBreakdown,
      favoriteCount,
    };
  },
};
