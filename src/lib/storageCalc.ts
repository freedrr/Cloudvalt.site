export interface StorageCalculation {
  usedBytes: number;
  maxBytes: number;
  remainingBytes: number;
  usedPercentage: number;
  formattedUsed: string;
  formattedRemaining: string;
  formattedMax: string;
  isNearFull: boolean;
  isFull: boolean;
}

export function formatExactBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 MB';
  const abs = Math.abs(bytes);

  if (abs < 1024) {
    return `${bytes} B`;
  }
  if (abs < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(decimals)} KB`;
  }
  if (abs < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(decimals)} MB`;
  }
  if (abs < 1024 * 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(decimals)} GB`;
  }
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(decimals)} TB`;
}

export function calculateStorage(usedBytes: number, maxBytes: number): StorageCalculation {
  const safeUsed = Math.max(0, usedBytes || 0);
  const safeMax = Math.max(1, maxBytes || 100 * 1024 * 1024);
  const remainingBytes = Math.max(0, safeMax - safeUsed);
  const usedPercentage = Math.min(100, Math.max(0, (safeUsed / safeMax) * 100));

  return {
    usedBytes: safeUsed,
    maxBytes: safeMax,
    remainingBytes,
    usedPercentage,
    formattedUsed: formatExactBytes(safeUsed),
    formattedRemaining: formatExactBytes(remainingBytes),
    formattedMax: formatExactBytes(safeMax, 0),
    isNearFull: usedPercentage >= 90,
    isFull: safeUsed >= safeMax,
  };
}
