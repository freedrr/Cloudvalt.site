export type FileCategory =
  | 'home'
  | 'all'
  | 'photos'
  | 'documents'
  | 'videos'
  | 'audio'
  | 'archives'
  | 'favorites'
  | 'trash';

export type FileType =
  | 'image'
  | 'document'
  | 'video'
  | 'audio'
  | 'archive'
  | 'code'
  | 'other';

export interface CloudFile {
  id: string;
  name: string;
  size: number;
  type: FileType;
  mimeType: string;
  b2FileId?: string;
  b2FileName?: string;
  b2BucketName?: string;
  storedInB2?: boolean;
  uploadedAt: string;
  updatedAt: string;
  isFavorite: boolean;
  isDeleted?: boolean;
  contentBase64?: string; // For small previewable files
  url?: string;
  storagePath?: string;
  thumbnailUrl?: string | null;
  previewUrl?: string;
  duration?: string;
  resolution?: string;
  userId?: string;
  userEmail?: string;
}

export interface StorageStats {
  usedBytes: number;
  maxBytes: number;
  totalFiles: number;
  categoryBreakdown: Record<FileType, { count: number; bytes: number }>;
  favoriteCount: number;
}
