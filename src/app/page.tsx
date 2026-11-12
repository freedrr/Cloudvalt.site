"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Home,
  Files,
  Image as ImageIcon,
  FileText,
  Video,
  Music,
  Archive,
  Grid,
  Star,
  Trash2,
  Search,
  UploadCloud,
  List,
  ArrowUpDown,
  Download,
  Pencil,
  Eye,
  Check,
  X,
  HardDrive,
  Sparkles,
  MessageSquare,
  Settings,
  MoreVertical,
  RotateCcw,
  ShieldCheck,
  Zap,
  CheckSquare,
  Square,
  FileCode,
  File as FileIcon,
  ChevronRight,
  Info,
  LogOut,
  Globe,
  Camera,
  Film,
  Play,
  User as UserIcon,
  ExternalLink,
  Flame,
  CreditCard,
  Database,
  ArrowUpRight,
  AlertTriangle,
} from "lucide-react";

import { AppLogo } from "@/components/app-logo";
import { LandingPage } from "@/components/landing-page";
import { User, getStoredUser, setStoredUser } from "@/lib/auth";
import { STORAGE_PLANS } from "@/lib/plans";
import { CloudFile, FileCategory, StorageStats } from "@/lib/types";
import {
  updateUserStoragePlan,
  auth,
  saveUserFileToFirestore,
  getUserFilesFromFirestore,
  deleteUserFileInFirestore,
  restoreUserFileInFirestore,
  renameUserFileInFirestore,
  toggleUserFileFavoriteInFirestore,
  detectFileType,
} from "@/lib/firebase";
import { calculateStorage, formatExactBytes } from "@/lib/storageCalc";

// Format bytes into human readable format
function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

// Format date into readable string
function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "Recent";
  }
}

// Get Auth Headers with Firebase ID Token
async function getAuthHeaders() {
  const token = await auth.currentUser?.getIdToken();
  return {
    'Authorization': token ? `Bearer ${token}` : '',
    'Content-Type': 'application/json'
  };
}

export default function CloudvaltApp() {
  // Authentication & View State
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentView, setCurrentView] = useState<"landing" | "vault">("landing");
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<string | null>(null);

  const openUpgradeModal = (reason?: string) => {
    setUpgradeReason(reason || null);
    setShowUpgradeModal(true);
  };

  // App & Storage State
  const [activeCategory, setActiveCategory] = useState<FileCategory>("home");
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [sortBy, setSortBy] = useState<"date" | "name" | "size">("date");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Upload state
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOverWindow, setIsDragOverWindow] = useState(false);
  const [uploadToast, setUploadToast] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    active: boolean;
    totalFiles: number;
    progress: number;
    currentFileName: string;
  }>({ active: false, totalFiles: 0, progress: 0, currentFileName: "" });

  // Modals state
  const [previewFile, setPreviewFile] = useState<CloudFile | null>(null);
  const [renameTarget, setRenameTarget] = useState<CloudFile | null>(null);
  const [newNameInput, setNewNameInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<CloudFile | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);

  // Feedback form state
  const [feedbackRating, setFeedbackRating] = useState(5);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSent, setFeedbackSent] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Check initial authentication
  useEffect(() => {
    const user = getStoredUser();
    if (user && user.emailVerified !== false) {
      setCurrentUser(user);
      setCurrentView("vault");
    } else {
      if (user && user.emailVerified === false) {
        setStoredUser(null);
      }
      setCurrentUser(null);
      setCurrentView("landing");
    }

    const handleAuthChange = () => {
      const u = getStoredUser();
      if (u && u.emailVerified !== false) {
        setCurrentUser(u);
        setCurrentView("vault");
      } else {
        setCurrentUser(null);
        setCurrentView("landing");
      }
    };

    window.addEventListener("cloudvalt_auth_change", handleAuthChange);
    return () => window.removeEventListener("cloudvalt_auth_change", handleAuthChange);
  }, []);

  // Close user dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Compute effective max bytes for current user
  const effectiveMaxBytes = useMemo(() => {
    if (currentUser?.maxStorageBytes) return currentUser.maxStorageBytes;
    if (stats?.maxBytes) return stats.maxBytes;
    return 100 * 1024 * 1024; // 100 MB default
  }, [currentUser, stats]);

  // Fetch files from Firestore or server
  const loadFiles = useCallback(async () => {
    try {
      const maxParam = currentUser?.maxStorageBytes || 100 * 1024 * 1024;
      if (currentUser?.id && currentUser.isFirebaseUser) {
        try {
          const fsData = await getUserFilesFromFirestore(
            currentUser.id,
            activeCategory,
            searchQuery,
            effectiveMaxBytes
          );
          if (fsData) {
            setFiles(fsData.files || []);
            setStats(fsData.stats || null);
            setLoading(false);
            return;
          }
        } catch (fsErr) {
          console.warn("Firestore files fetch notice:", fsErr);
        }
      }

      const userId = currentUser?.id || "default_user";
      const res = await fetch(
        `/api/files?category=${activeCategory}&q=${encodeURIComponent(searchQuery)}&maxBytes=${maxParam}&userId=${userId}`,
        { headers: await getAuthHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files || []);
        if (data.stats) {
          setStats({
            ...data.stats,
            maxBytes: effectiveMaxBytes,
          });
        }
      }
    } catch (err) {
      console.error("Failed to load files:", err);
    } finally {
      setLoading(false);
    }
  }, [activeCategory, searchQuery, currentUser, effectiveMaxBytes]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  // Global drag-and-drop listeners
  useEffect(() => {
    let dragCounter = 0;

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounter++;
      if (e.dataTransfer?.types?.includes("Files")) {
        setIsDragOverWindow(true);
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter === 0) {
        setIsDragOverWindow(false);
      }
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      setIsDragOverWindow(false);

      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        await handleFilesUpload(e.dataTransfer.files);
      }
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, []);

  // Generate video thumbnail frame on client
  const generateVideoThumbnail = (file: File): Promise<string | undefined> => {
    return new Promise((resolve) => {
      try {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.playsInline = true;
        const objectUrl = URL.createObjectURL(file);
        video.src = objectUrl;

        let isDone = false;
        const cleanup = () => {
          if (!isDone) {
            isDone = true;
            try {
              URL.revokeObjectURL(objectUrl);
              video.remove();
            } catch {}
          }
        };

        const timer = setTimeout(() => {
          cleanup();
          resolve(undefined);
        }, 3500);

        video.onloadeddata = () => {
          try {
            video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
          } catch {
            cleanup();
            resolve(undefined);
          }
        };

        video.onseeked = () => {
          clearTimeout(timer);
          try {
            const canvas = document.createElement("canvas");
            const width = Math.min(480, video.videoWidth || 320);
            const height = Math.round((width * (video.videoHeight || 180)) / (video.videoWidth || 320));
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(video, 0, 0, width, height);
              const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
              cleanup();
              resolve(dataUrl);
              return;
            }
          } catch {}
          cleanup();
          resolve(undefined);
        };

        video.onerror = () => {
          clearTimeout(timer);
          cleanup();
          resolve(undefined);
        };
      } catch {
        resolve(undefined);
      }
    });
  };

  // Upload single file in chunks to prevent browser & server memory crashes for large files (up to 10GB+)
  const uploadSingleFileChunked = async (
    file: File,
    userId: string,
    maxBytes: number,
    onProgress: (loaded: number, total: number) => void
  ): Promise<{ ok: boolean; status: number; data?: any }> => {
    const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB per slice
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const headers = await getAuthHeaders();

    // 1. Initialize session
    const initRes = await fetch("/api/upload/chunk/init", {
      method: "POST",
      headers: {
        ...headers,
        "x-max-bytes": String(maxBytes),
      },
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || "application/octet-stream",
        userId,
      }),
    });

    const initData = await initRes.json().catch(() => ({}));
    if (!initRes.ok || !initData.uploadId) {
      return { ok: false, status: initRes.status, data: initData };
    }

    const uploadId = initData.uploadId;
    let bytesUploaded = 0;

    // 2. Upload chunks sequentially
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const chunkBlob = file.slice(start, end);

      const chunkFormData = new FormData();
      chunkFormData.append("uploadId", uploadId);
      chunkFormData.append("chunkIndex", String(chunkIndex));
      chunkFormData.append("chunk", chunkBlob, `part_${chunkIndex}`);

      const chunkRes = await fetch("/api/upload/chunk", {
        method: "POST",
        headers: {
          Authorization: headers.Authorization || "",
        },
        body: chunkFormData,
      });

      if (!chunkRes.ok) {
        let errJson = {};
        try { errJson = await chunkRes.json(); } catch {}
        return { ok: false, status: chunkRes.status, data: errJson };
      }

      bytesUploaded += (end - start);
      onProgress(bytesUploaded, file.size);
    }

    // 3. Complete and assemble without high RAM
    const completeRes = await fetch("/api/upload/chunk/complete", {
      method: "POST",
      headers,
      body: JSON.stringify({
        uploadId,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        userId,
        totalChunks,
      }),
    });

    const completeData = await completeRes.json().catch(() => ({}));
    return {
      ok: completeRes.ok,
      status: completeRes.status,
      data: completeData,
    };
  };

  // Upload handler with progress tracking, chunking for large files, and storage quota enforcement
  const handleFilesUpload = async (fileList: FileList | File[]) => {
    if (!fileList || fileList.length === 0) return;

    const filesArray = Array.from(fileList);
    const count = filesArray.length;
    const totalUploadBytes = filesArray.reduce((acc, f) => acc + f.size, 0);
    const currentUsed = stats?.usedBytes || 0;
    const currentMax = effectiveMaxBytes;

    // Check if any single file exceeds current max storage plan limit
    const oversizedFile = filesArray.find((f) => f.size > currentMax);
    // Check if total upload size plus used storage exceeds current max storage plan limit
    const exceedsQuota = currentUsed + totalUploadBytes > currentMax;

    if (oversizedFile || exceedsQuota) {
      let reasonMsg = "";
      if (oversizedFile) {
        reasonMsg = `The file "${oversizedFile.name}" is ${formatBytes(oversizedFile.size)}, which exceeds your current ${formatBytes(currentMax)} storage plan limit. Please upgrade your storage plan to upload larger files.`;
      } else {
        reasonMsg = `Uploading ${formatBytes(totalUploadBytes)} of media will exceed your storage plan space (${storageCalc.formattedRemaining} left out of ${formatBytes(currentMax)}). Please upgrade your storage plan for more space.`;
      }

      openUpgradeModal(reasonMsg);
      showNotification("File size exceeds your storage plan limit. Please upgrade your storage plan.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setIsUploading(true);
    const firstFileName = filesArray[0]?.name || "file";

    setUploadProgress({
      active: true,
      totalFiles: count,
      progress: 5,
      currentFileName: count > 1 ? `${firstFileName} + ${count - 1} more` : firstFileName,
    });

    const userId = currentUser?.id || "default_user";
    const savedFiles: CloudFile[] = [];
    let overallUploadedBytes = 0;

    // Pre-extract video thumbnails for instant previews
    const videoThumbs = new Map<string, string>();
    for (const f of filesArray) {
      if (f.type.startsWith("video/") || f.name.match(/\.(mp4|mov|mkv|webm|avi|wmv|m4v)$/i)) {
        try {
          const thumb = await generateVideoThumbnail(f);
          if (thumb) videoThumbs.set(f.name, thumb);
        } catch {}
      }
    }

    try {
      for (let fileIdx = 0; fileIdx < count; fileIdx++) {
        const file = filesArray[fileIdx];
        const videoThumb = videoThumbs.get(file.name);

        setUploadProgress({
          active: true,
          totalFiles: count,
          progress: Math.max(5, Math.round((overallUploadedBytes / totalUploadBytes) * 98)),
          currentFileName: `Uploading ${file.name} (${fileIdx + 1}/${count})`,
        });

        // If file is > 8MB, use chunked stream upload to prevent RAM crash for large files (e.g. 5GB - 10GB+)
        if (file.size > 8 * 1024 * 1024) {
          const chunkResult = await uploadSingleFileChunked(
            file,
            userId,
            effectiveMaxBytes,
            (fileChunkLoaded) => {
              const currentTotal = overallUploadedBytes + fileChunkLoaded;
              const pct = Math.min(98, Math.round((currentTotal / totalUploadBytes) * 100));
              setUploadProgress((prev) => ({ ...prev, progress: pct }));
            }
          );

          if (!chunkResult.ok || !chunkResult.data?.file) {
            if (chunkResult.status === 413 || chunkResult.data?.code === "STORAGE_LIMIT_EXCEEDED") {
              openUpgradeModal(
                chunkResult.data?.error ||
                  `File size exceeds your current ${formatBytes(effectiveMaxBytes)} storage plan limit. Please upgrade your storage plan.`
              );
              showNotification("File size exceeds your storage plan limit. Upgrade your storage plan.");
            } else {
              showNotification(`Failed to upload ${file.name}.`);
            }
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
          }

          const savedFile = chunkResult.data.file;
          if (videoThumb) {
            savedFile.thumbnailUrl = videoThumb;
          }
          savedFiles.push(savedFile);
          overallUploadedBytes += file.size;
        } else {
          // Standard upload for small files
          const fileFormData = new FormData();
          fileFormData.append("userId", userId);
          fileFormData.append("files", file);

          const res = await fetch("/api/files", {
            method: "POST",
            headers: {
              Authorization: (await getAuthHeaders()).Authorization || "",
              "x-max-bytes": String(effectiveMaxBytes),
            },
            body: fileFormData,
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            if (res.status === 413 || errData?.code === "STORAGE_LIMIT_EXCEEDED") {
              openUpgradeModal(
                errData?.error ||
                  `File size exceeds your current ${formatBytes(effectiveMaxBytes)} storage plan limit. Please upgrade your storage plan.`
              );
              showNotification("File size exceeds your storage plan limit. Upgrade your storage plan.");
            } else {
              showNotification(`Failed to upload ${file.name}.`);
            }
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
          }

          const data = await res.json();
          const sfList: CloudFile[] = data.files || [];
          for (const sf of sfList) {
            if (videoThumb) sf.thumbnailUrl = videoThumb;
            savedFiles.push(sf);
          }
          overallUploadedBytes += file.size;
        }
      }

      setUploadProgress((prev) => ({ ...prev, progress: 100 }));

      // Store file record in Firestore under user's files with full schema & ordering
      if (currentUser?.id && currentUser.isFirebaseUser && savedFiles.length > 0) {
        for (const sf of savedFiles) {
          try {
            await saveUserFileToFirestore(currentUser.id, currentUser.email, {
              ...sf,
              b2FileId: sf.b2FileId || `b2_${sf.id}`,
              b2FileName: sf.b2FileName || `users/${currentUser.id}/${sf.id}_${sf.name}`,
              userId: currentUser.id,
              userEmail: currentUser.email,
              uploadedAt: new Date().toISOString(),
              thumbnailUrl: sf.thumbnailUrl || `/api/files/${sf.id}`,
              url: `/api/files/${sf.id}`,
            });
          } catch (fsErr) {
            console.warn("Firestore file save:", fsErr);
          }
        }
      }

      showNotification(`Uploaded ${savedFiles.length} file${savedFiles.length > 1 ? "s" : ""} to Cloudvalt.`);
      await loadFiles();
    } catch (err) {
      console.error("Upload error:", err);
      showNotification("Upload failed due to network error.");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setTimeout(() => {
        setUploadProgress({ active: false, totalFiles: 0, progress: 0, currentFileName: "" });
      }, 1500);
    }
  };

  // Toast notification helper
  const showNotification = (msg: string) => {
    setUploadToast(msg);
    setTimeout(() => {
      setUploadToast(null);
    }, 3500);
  };

  // Log Out Handler
  const handleLogout = async () => {
    try {
      await auth.signOut().catch(() => {});
    } catch {}
    setStoredUser(null);
    setCurrentUser(null);
    setCurrentView("landing");
    setShowUserDropdown(false);
    setShowSettings(false);
    showNotification("You have been logged out of your vault.");
  };

  // Plan Upgrade Handler
  const handleUpgradePlan = async (planId: "100mb" | "50gb" | "250gb" | "1tb") => {
    const planInfo = STORAGE_PLANS[planId];
    if (!planInfo) return;

    if (currentUser) {
      const updatedUser: User = {
        ...currentUser,
        plan: planInfo.name,
        planId,
        maxStorageBytes: planInfo.maxBytes,
      };

      if (currentUser.id && currentUser.isFirebaseUser) {
        await updateUserStoragePlan(currentUser.id, planId).catch((e) =>
          console.warn("Firestore plan sync:", e)
        );
      }

      setStoredUser(updatedUser);
      setCurrentUser(updatedUser);
      if (stats) {
        setStats({ ...stats, maxBytes: planInfo.maxBytes });
      }
      showNotification(`Upgraded to ${planInfo.name} (${planInfo.priceFormatted})!`);
    }

    setShowUpgradeModal(false);
    setShowSettings(false);
  };

  // Toggle Favorite
  const toggleFavorite = async (file: CloudFile, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const nextFav = !file.isFavorite;
    try {
      if (currentUser?.id && currentUser.isFirebaseUser) {
        await toggleUserFileFavoriteInFirestore(currentUser.id, file.id, nextFav).catch((err) =>
          console.warn("Firestore favorite sync:", err)
        );
      }
      const res = await fetch(`/api/files/${file.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isFavorite: nextFav }),
      });
      if (res.ok) {
        setFiles((prev) =>
          prev.map((f) => (f.id === file.id ? { ...f, isFavorite: nextFav } : f))
        );
        if (stats) {
          setStats({
            ...stats,
            favoriteCount: stats.favoriteCount + (nextFav ? 1 : -1),
          });
        }
      }
    } catch (err) {
      console.error("Favorite error:", err);
    }
  };

  // Direct Permanent Delete
  const confirmDelete = async () => {
    if (!deleteTarget) return;

    try {
      if (currentUser?.id && currentUser.isFirebaseUser) {
        await deleteUserFileInFirestore(currentUser.id, deleteTarget.id, true).catch((err) =>
          console.warn("Firestore delete sync:", err)
        );
      }

      const deleteUrl =
        `/api/files/${encodeURIComponent(deleteTarget.id)}?permanent=true` +
        (currentUser?.id
          ? `&userId=${encodeURIComponent(currentUser.id)}`
          : "") +
        (deleteTarget.b2FileName
          ? `&b2FileName=${encodeURIComponent(deleteTarget.b2FileName)}`
          : "");

      const res = await fetch(deleteUrl, { 
        method: "DELETE",
        headers: await getAuthHeaders()
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok && !data.success) {
        throw new Error(data.details || data.error || `Delete failed (${res.status})`);
      }

      showNotification("File permanently deleted from vault and Backblaze B2.");

      setFiles((prev) => prev.filter((f) => f.id !== deleteTarget.id));

      if (previewFile?.id === deleteTarget.id) {
        setPreviewFile(null);
      }

      setDeleteTarget(null);
      await loadFiles();

    } catch (err: any) {
      console.error("Delete failed:", err);
      showNotification(err.message || "Failed to delete file.");
    }
  };

  // Rename File
  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTarget || !newNameInput.trim()) return;
    const cleanName = newNameInput.trim();

    try {
      if (currentUser?.id && currentUser.isFirebaseUser) {
        await renameUserFileInFirestore(currentUser.id, renameTarget.id, cleanName).catch((err) =>
          console.warn("Firestore rename sync:", err)
        );
      }
      const res = await fetch(`/api/files/${renameTarget.id}`, {
        method: "PATCH",
        headers: await getAuthHeaders(),
        body: JSON.stringify({ newName: cleanName }),
      });
      if (res.ok) {
        const data = await res.json();
        setFiles((prev) =>
          prev.map((f) => (f.id === renameTarget.id ? { ...f, name: data.file.name } : f))
        );
        showNotification("File renamed successfully.");
        setRenameTarget(null);
      }
    } catch (err) {
      console.error("Rename error:", err);
    }
  };

  // Download File
  const downloadFile = async (file: CloudFile, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      showNotification(`Downloading ${file.name}...`);
      const downloadUrl = `/api/files/${file.id}?download=true${currentUser?.id ? `&userId=${currentUser.id}` : ""}`;
      const res = await fetch(downloadUrl, { headers: await getAuthHeaders() });
      if (!res.ok) throw new Error("Download request failed");

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(link);
      showNotification(`Downloaded ${file.name}`);
    } catch (err) {
      console.error("Download error:", err);
      window.open(`/api/files/${file.id}?download=true${currentUser?.id ? `&userId=${currentUser.id}` : ""}`, "_blank");
    }
  };

  // Bulk Selection
  const toggleSelect = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const listToSelect = activeCategory === "home" && !searchQuery ? files : filteredAndSortedFiles;
    if (selectedIds.size === listToSelect.length && listToSelect.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(listToSelect.map((f) => f.id)));
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);

    let succeeded = 0;
    let failed = 0;

    for (const id of ids) {
      try {
        if (currentUser?.id && currentUser.isFirebaseUser) {
          await deleteUserFileInFirestore(currentUser.id, id, true).catch((e) =>
            console.warn("Firestore bulk delete sync:", e)
          );
        }

        const file = files.find(f => f.id === id);
        const url =
          `/api/files/${encodeURIComponent(id)}?permanent=true` +
          (currentUser?.id
            ? `&userId=${encodeURIComponent(currentUser.id)}`
            : "") +
          (file?.b2FileName
            ? `&b2FileName=${encodeURIComponent(file.b2FileName)}`
            : "");

        const res = await fetch(url, { 
          method: "DELETE",
          headers: await getAuthHeaders()
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok && !data.success) {
          throw new Error(`Delete failed (${res.status})`);
        }

        succeeded++;
      } catch (err) {
        console.error(`Failed to delete ${id}:`, err);
        failed++;
      }
    }

    setSelectedIds(new Set());

    showNotification(
      `${succeeded} file${succeeded !== 1 ? "s" : ""} permanently deleted${failed ? `, ${failed} failed` : ""}.`
    );
    await loadFiles();
  };

  const handleBulkDownload = () => {
    const selected = files.filter((f) => selectedIds.has(f.id));
    selected.forEach((f) => {
      setTimeout(() => downloadFile(f), 200);
    });
    showNotification(`Downloading ${selected.length} files...`);
  };

  // Filter & Sort
  const filteredAndSortedFiles = useMemo(() => {
    let result = [...files];

    result.sort((a, b) => {
      if (sortBy === "name") {
        return sortOrder === "asc"
          ? a.name.localeCompare(b.name)
          : b.name.localeCompare(a.name);
      }
      if (sortBy === "size") {
        return sortOrder === "asc" ? a.size - b.size : b.size - a.size;
      }
      const da = new Date(a.uploadedAt).getTime();
      const db = new Date(b.uploadedAt).getTime();
      return sortOrder === "asc" ? da - db : db - da;
    });

    return result;
  }, [files, sortBy, sortOrder]);

  // File Icon Renderer
  const renderFileIcon = (file: CloudFile | null, sizeClass = "h-5 w-5") => {
    if (!file) return <FileIcon className={`${sizeClass} text-zinc-300`} />;
    const fType = file.type && file.type !== "other" ? file.type : detectFileType(file.name, file.mimeType);
    switch (fType) {
      case "image":
        return <Camera className={`${sizeClass} text-emerald-400`} />;
      case "video":
        return <Film className={`${sizeClass} text-sky-400`} />;
      case "document":
        return <FileText className={`${sizeClass} text-amber-400`} />;
      case "audio":
        return <Music className={`${sizeClass} text-purple-400`} />;
      case "archive":
        return <Archive className={`${sizeClass} text-indigo-400`} />;
      case "code":
        return <FileCode className={`${sizeClass} text-cyan-400`} />;
      default:
        return <FileIcon className={`${sizeClass} text-zinc-300`} />;
    }
  };

  // Comprehensive Grid Media Preview Renderer
  const renderGridMediaPreview = (file: CloudFile) => {
    const effectiveType = file.type && file.type !== "other" ? file.type : detectFileType(file.name, file.mimeType);
    const ext = file.name.split(".").pop()?.toUpperCase() || "";

    if (effectiveType === "image") {
      return (
        <div className="absolute inset-0 w-full h-full overflow-hidden bg-zinc-950 flex items-center justify-center">
          <img
            src={file.thumbnailUrl || file.contentBase64 || file.url || `/api/files/${file.id}`}
            alt={file.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 z-10"
            onError={(e) => {
              (e.currentTarget as HTMLElement).style.display = "none";
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center p-4 bg-zinc-950/80 text-emerald-400 pointer-events-none">
            <Camera className="h-10 w-10 text-emerald-400/80" />
          </div>
          {file.resolution && (
            <div className="absolute bottom-2 right-2 z-20 px-1.5 py-0.5 rounded bg-black/80 font-mono text-[10px] text-emerald-400 pointer-events-none">
              {file.resolution.split("·")[0].trim()}
            </div>
          )}
        </div>
      );
    }

    if (effectiveType === "video") {
      return (
        <div className="absolute inset-0 w-full h-full overflow-hidden bg-black flex items-center justify-center">
          {/* Fallback film icon in background */}
          <div className="absolute inset-0 flex flex-col items-center justify-center p-4 bg-zinc-950 text-sky-400 z-0 pointer-events-none">
            <Film className="h-10 w-10 text-sky-400/80 mb-1" />
            <span className="text-[10px] font-mono uppercase tracking-wider text-sky-300">{ext || "VIDEO"}</span>
          </div>

          {/* Primary Video or Thumbnail Layer */}
          {file.thumbnailUrl ? (
            <img
              src={file.thumbnailUrl}
              alt={file.name}
              className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 z-20"
              onError={(e) => {
                (e.currentTarget as HTMLElement).style.display = "none";
              }}
            />
          ) : (
            <video
              src={`${file.url || `/api/files/${file.id}`}#t=0.5`}
              className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 z-20"
              muted
              preload="metadata"
              playsInline
              onError={(e) => {
                (e.currentTarget as HTMLElement).style.display = "none";
              }}
            />
          )}

          {/* Frosted Play button overlay */}
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/25 group-hover:bg-black/10 transition-colors pointer-events-none">
            <div className="h-10 w-10 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center text-white shadow-xl group-hover:scale-110 transition-transform">
              <Play className="h-4 w-4 fill-white ml-0.5" />
            </div>
          </div>

          {/* Duration or Format Badge */}
          <div className="absolute bottom-2 right-2 z-30 px-1.5 py-0.5 rounded bg-black/85 font-mono text-[10px] text-zinc-200 pointer-events-none border border-white/10">
            {file.duration || ext || "Video"}
          </div>
        </div>
      );
    }

    if (effectiveType === "audio") {
      return (
        <div className="absolute inset-0 w-full h-full z-10 flex flex-col items-center justify-center p-3 bg-gradient-to-b from-purple-950/50 via-zinc-950 to-zinc-950 border border-purple-500/20 overflow-hidden">
          {/* Animated sound bars graphic */}
          <div className="flex items-end justify-center gap-1 mb-2.5 h-8">
            <div className="w-1 bg-purple-500/70 rounded-full h-3 group-hover:h-6 transition-all duration-300" />
            <div className="w-1 bg-purple-400 rounded-full h-5 group-hover:h-8 transition-all duration-300" />
            <div className="w-1 bg-purple-300 rounded-full h-7 group-hover:h-5 transition-all duration-300" />
            <div className="w-1 bg-purple-400 rounded-full h-4 group-hover:h-7 transition-all duration-300" />
            <div className="w-1 bg-purple-500/70 rounded-full h-6 group-hover:h-4 transition-all duration-300" />
          </div>
          <div className="h-9 w-9 rounded-full bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400 mb-1 shadow-lg group-hover:scale-110 transition-transform">
            <Music className="h-4.5 w-4.5" />
          </div>
          <span className="text-[10px] font-mono text-purple-300 font-bold uppercase tracking-wider">
            {ext || "AUDIO"} TRACK
          </span>
          {file.duration && (
            <div className="absolute bottom-2 right-2 z-20 px-1.5 py-0.5 rounded bg-black/85 font-mono text-[10px] text-purple-300 pointer-events-none border border-purple-500/20">
              {file.duration}
            </div>
          )}
        </div>
      );
    }

    if (effectiveType === "archive") {
      return (
        <div className="absolute inset-0 w-full h-full z-10 flex flex-col items-center justify-center p-3 bg-gradient-to-b from-indigo-950/50 via-zinc-950 to-zinc-950 border border-indigo-500/20 overflow-hidden">
          {/* Archive / Compression Package Graphic */}
          <div className="relative mb-2">
            <div className="h-11 w-11 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shadow-lg group-hover:scale-105 transition-transform">
              <Archive className="h-6 w-6" />
            </div>
            <div className="absolute -bottom-1 -right-1 px-1 py-0.2 rounded bg-indigo-600 text-white font-mono text-[8px] font-black uppercase tracking-tighter">
              {ext || "ZIP"}
            </div>
          </div>
          <span className="text-[10px] font-mono text-indigo-300 font-semibold uppercase tracking-wider">
            Archive Package
          </span>
          <div className="absolute bottom-2 right-2 z-20 px-1.5 py-0.5 rounded bg-black/80 font-mono text-[10px] text-indigo-300 pointer-events-none border border-indigo-500/20">
            Compressed
          </div>
        </div>
      );
    }

    if (effectiveType === "document") {
      return (
        <div className="absolute inset-0 w-full h-full z-10 flex flex-col items-center justify-center p-3 bg-gradient-to-b from-amber-950/40 via-zinc-950 to-zinc-950 border border-amber-500/20 overflow-hidden">
          {/* Faux Document Sheet */}
          <div className="w-14 h-16 rounded-lg bg-zinc-900 border border-amber-500/30 p-2 flex flex-col justify-between shadow-lg group-hover:scale-105 transition-transform mb-1.5">
            <div className="flex items-center justify-between">
              <FileText className="h-4 w-4 text-amber-400" />
              <span className="text-[8px] font-mono font-bold text-amber-300 uppercase">{ext || "DOC"}</span>
            </div>
            <div className="space-y-1">
              <div className="h-1 bg-zinc-700 rounded-full w-full" />
              <div className="h-1 bg-zinc-800 rounded-full w-3/4" />
              <div className="h-1 bg-zinc-800 rounded-full w-1/2" />
            </div>
          </div>
          <span className="text-[10px] font-mono text-amber-300 font-semibold uppercase tracking-wider">
            {ext || "DOCUMENT"}
          </span>
        </div>
      );
    }

    if (effectiveType === "code") {
      return (
        <div className="absolute inset-0 w-full h-full z-10 flex flex-col items-center justify-center p-3 bg-gradient-to-b from-cyan-950/40 via-zinc-950 to-zinc-950 border border-cyan-500/20 overflow-hidden">
          {/* Faux Code Terminal */}
          <div className="w-16 h-14 rounded-lg bg-black border border-cyan-500/30 p-1.5 flex flex-col justify-between shadow-lg group-hover:scale-105 transition-transform mb-1.5">
            <div className="flex items-center gap-1 border-b border-zinc-800 pb-1">
              <div className="w-1.5 h-1.5 rounded-full bg-red-500/80" />
              <div className="w-1.5 h-1.5 rounded-full bg-amber-500/80" />
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/80" />
              <span className="text-[7px] font-mono text-cyan-400 ml-auto">{ext || "CODE"}</span>
            </div>
            <div className="space-y-1 py-0.5">
              <div className="h-1 bg-cyan-400/60 rounded-full w-3/4" />
              <div className="h-1 bg-zinc-700 rounded-full w-full" />
              <div className="h-1 bg-cyan-500/40 rounded-full w-1/2" />
            </div>
          </div>
          <span className="text-[10px] font-mono text-cyan-300 font-semibold uppercase tracking-wider">
            Source Code
          </span>
        </div>
      );
    }

    // Default / Other files
    return (
      <div className="absolute inset-0 w-full h-full z-10 flex flex-col items-center justify-center p-3 bg-zinc-950 border border-zinc-800/80">
        <div className="h-10 w-10 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-300 mb-1.5 shadow-md group-hover:scale-105 transition-transform">
          <FileIcon className="h-5 w-5" />
        </div>
        <span className="text-[10px] font-mono text-zinc-400 font-semibold uppercase tracking-wider">
          {ext || "FILE"}
        </span>
      </div>
    );
  };

  // List View Media Thumb Renderer
  const renderListMediaThumb = (file: CloudFile, sizeClass = "h-10 w-10") => {
    const effectiveType = file.type && file.type !== "other" ? file.type : detectFileType(file.name, file.mimeType);

    if (effectiveType === "image" || file.thumbnailUrl || file.contentBase64) {
      return (
        <img
          src={file.thumbnailUrl || file.contentBase64 || file.url || `/api/files/${file.id}`}
          alt={file.name}
          className="h-full w-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLElement).style.display = "none";
          }}
        />
      );
    }

    if (effectiveType === "video") {
      return (
        <div className="relative h-full w-full bg-black flex items-center justify-center">
          <video
            src={`${file.url || `/api/files/${file.id}`}#t=0.5`}
            className="h-full w-full object-cover"
            muted
            preload="metadata"
            playsInline
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <Play className="h-3 w-3 fill-white text-white" />
          </div>
        </div>
      );
    }

    return renderFileIcon(file, sizeClass.includes("h-8") ? "h-4 w-4" : "h-5 w-5");
  };

  const maxBytes = effectiveMaxBytes;
  const usedBytes = stats?.usedBytes || 0;
  const storageCalc = useMemo(() => {
    return calculateStorage(usedBytes, maxBytes);
  }, [usedBytes, maxBytes]);
  const usedPercent = storageCalc.usedPercentage;

  const currentPlanName = currentUser?.plan || "100 MB Free (Test Mode)";
  const isTestMode = !currentUser?.planId || currentUser.planId === "100mb";

  if (currentView === "landing") {
    return (
      <LandingPage
        currentUser={currentUser}
        onLoginSuccess={(user) => {
          setCurrentUser(user);
          setCurrentView("vault");
          showNotification(`Welcome, ${user.name}!`);
        }}
        onEnterVault={() => setCurrentView("vault")}
        onSelectPlanUpgrade={(p) => {
          handleUpgradePlan(p);
          setCurrentView("vault");
        }}
      />
    );
  }

  const displayName = currentUser?.name || "Vault Creator";
  const displayEmail = currentUser?.email || "user@cloudvalt.site";
  const userInitials = displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex h-screen w-full bg-black text-white font-sans overflow-hidden select-none">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,application/*,.mkv,.mov,.mp4,.avi,.webm,.zip,.pdf,.doc,.docx"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleFilesUpload(e.target.files);
        }}
      />

      {/* Global Window Drag-Over Overlay */}
      <AnimatePresence>
        {isDragOverWindow && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center border-4 border-dashed border-white/80 p-8 text-center pointer-events-none"
          >
            <motion.div
              animate={{ y: [-10, 10, -10] }}
              transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
            >
              <UploadCloud className="h-20 w-20 text-white mb-4" />
            </motion.div>
            <h2 className="text-3xl font-extrabold tracking-tight">Drop Photos & Videos to Upload</h2>
            <p className="text-zinc-400 mt-2 text-sm">
              Files will be stored securely in your {currentPlanName} CloudValt vault with lossless quality.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Upload Progress Toast */}
      <AnimatePresence>
        {uploadProgress.active && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.95 }}
            className="fixed bottom-6 right-6 z-50 w-80 bg-zinc-950 border border-zinc-800 rounded-2xl p-4 shadow-2xl shadow-black text-white flex flex-col gap-2.5"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400">
                  <UploadCloud className="h-4 w-4 animate-pulse" />
                </div>
                <span className="text-xs font-semibold text-white">
                  Uploading {uploadProgress.totalFiles} file{uploadProgress.totalFiles > 1 ? "s" : ""}
                </span>
              </div>
              <span className="text-xs font-mono font-bold text-emerald-400">
                {uploadProgress.progress}%
              </span>
            </div>

            <div className="w-full bg-zinc-900 h-2 rounded-full overflow-hidden border border-zinc-800">
              <motion.div
                className="bg-gradient-to-r from-emerald-500 to-teal-400 h-full rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress.progress}%` }}
              />
            </div>

            <div className="text-[11px] text-zinc-400 truncate font-mono">
              {uploadProgress.currentFileName || "Syncing with Backblaze B2 S3 storage..."}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Notification Toast */}
      <AnimatePresence>
        {uploadToast && !uploadProgress.active && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 right-6 z-50 bg-zinc-900 border border-zinc-700 text-white px-4 py-3 rounded-2xl shadow-2xl flex items-center gap-3"
          >
            <Check className="h-4 w-4 text-emerald-400 shrink-0" />
            <span className="text-sm font-medium">{uploadToast}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className="w-64 border-r border-zinc-900 bg-zinc-950 flex flex-col shrink-0">
        <div className="p-4 border-b border-zinc-900 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setActiveCategory("home")}>
            <AppLogo size={36} showWordmark={false} />
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-lg font-bold tracking-tight text-white block leading-none">
                  Cloudvalt
                </span>
                <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-zinc-900 text-zinc-400 border border-zinc-800">
                  .site
                </span>
              </div>
              <span className="text-[11px] text-emerald-400 font-medium">
                {isTestMode ? "100 MB Test Mode" : currentPlanName}
              </span>
            </div>
          </div>
        </div>

        <div className="p-4">
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="w-full flex items-center justify-center gap-2.5 bg-white text-black hover:bg-zinc-200 active:bg-zinc-300 font-semibold text-sm py-2.5 px-4 rounded-xl transition-all shadow-md shadow-white/5 disabled:opacity-50"
          >
            {isUploading ? (
              <div className="h-4 w-4 border-2 border-black border-t-transparent animate-spin rounded-full" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            <span>{isUploading ? "Uploading..." : "Upload Photos & Videos"}</span>
          </motion.button>
        </div>

        <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
          {[
            { id: "home", label: "Home", icon: Home },
            { id: "photos", label: "Photos", icon: Camera, count: stats?.categoryBreakdown?.image?.count, highlight: true },
            { id: "videos", label: "Videos", icon: Film, count: stats?.categoryBreakdown?.video?.count, highlight: true },
            { id: "documents", label: "Documents", icon: FileText, count: stats?.categoryBreakdown?.document?.count },
            { id: "audio", label: "Audio", icon: Music, count: stats?.categoryBreakdown?.audio?.count },
            { id: "archives", label: "Archives", icon: Archive, count: stats?.categoryBreakdown?.archive?.count },
            { id: "favorites", label: "Favorites", icon: Star, count: stats?.favoriteCount },
          ].map((item) => {
            const Icon = item.icon;
            const isActive = activeCategory === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setActiveCategory(item.id as FileCategory);
                  setSelectedIds(new Set());
                }}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-zinc-800 text-white font-semibold"
                    : "text-zinc-400 hover:text-white hover:bg-zinc-900"
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      isActive
                        ? "text-white"
                        : item.highlight
                        ? item.id === "photos"
                          ? "text-emerald-400"
                          : "text-sky-400"
                        : "text-zinc-400"
                    }`}
                  />
                  <span className="truncate">{item.label}</span>
                </div>
                {item.count !== undefined && item.count > 0 && (
                  <span className="text-[11px] tabular-nums px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-800">
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-zinc-900">
          <div className="p-3.5 rounded-xl border border-zinc-800/80 bg-zinc-900/40">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="font-semibold text-zinc-300">
                {isTestMode ? "Test Storage" : "Vault Storage"}
              </span>
              <span className="text-zinc-400 font-mono text-[11px]">{storageCalc.usedPercentage.toFixed(1)}%</span>
            </div>
            <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
              <div
                className="bg-emerald-400 h-full transition-all duration-500 rounded-full"
                style={{ width: `${Math.max(2, storageCalc.usedPercentage)}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-2 text-[11px] font-mono">
              <span className="text-zinc-300 font-medium">{storageCalc.formattedUsed} used</span>
              <span className="text-emerald-400 font-semibold">{storageCalc.formattedRemaining} left</span>
            </div>
            <div className="text-[10px] text-zinc-400 mt-1 flex items-center justify-between border-t border-zinc-800/60 pt-1.5 font-mono">
              <span>Quota: {storageCalc.formattedMax}</span>
              <span>{stats?.totalFiles || 0} file{stats?.totalFiles === 1 ? "" : "s"}</span>
            </div>

            <button
              onClick={() => openUpgradeModal()}
              className="mt-3 w-full bg-zinc-800 hover:bg-zinc-700 text-white font-semibold text-[11px] py-1.5 px-2 rounded-lg flex items-center justify-center gap-1.5 transition-colors border border-zinc-700/60"
            >
              <Flame className="h-3.5 w-3.5 text-amber-400" />
              <span>Upgrade (From $3.99)</span>
            </button>
          </div>

          <div className="flex items-center justify-between mt-3 text-xs text-zinc-400 px-1 pt-1">
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-1.5 hover:text-white transition-colors"
            >
              <Settings className="h-3.5 w-3.5" /> Settings
            </button>
            <button
              onClick={() => setShowFeedback(true)}
              className="flex items-center gap-1.5 hover:text-white transition-colors"
            >
              <MessageSquare className="h-3.5 w-3.5" /> Feedback
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col h-full overflow-hidden bg-black">
        {/* Top Header Bar with Proper Padding */}
        <header className="h-20 border-b border-zinc-900 px-6 sm:px-8 pt-3 flex items-center justify-between gap-4 shrink-0 bg-black/75 backdrop-blur-md">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input
              type="text"
              placeholder="Search photos, videos, files in vault..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-8 py-2 text-sm text-white placeholder-zinc-400 focus:outline-none focus:border-white transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => openUpgradeModal()}
              className="hidden sm:flex items-center gap-1.5 text-xs text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-1.5 rounded-xl border border-amber-500/30 transition-all font-semibold"
            >
              <Flame className="h-3.5 w-3.5 text-amber-400" />
              <span>50GB · 250GB · 1TB</span>
            </motion.button>

            <div className="flex items-center gap-1 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 bg-zinc-950">
              <ArrowUpDown className="h-3.5 w-3.5 text-zinc-400" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as "date" | "name" | "size")}
                className="bg-transparent text-white focus:outline-none cursor-pointer"
              >
                <option value="date" className="bg-zinc-900 text-white">Date</option>
                <option value="name" className="bg-zinc-900 text-white">Name</option>
                <option value="size" className="bg-zinc-900 text-white">Size</option>
              </select>
              <button
                onClick={() => setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"))}
                className="hover:text-white ml-1 font-mono uppercase"
              >
                {sortOrder}
              </button>
            </div>

            {/* User Profile Pill & Dropdown */}
            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setShowUserDropdown((prev) => !prev)}
                className="flex items-center gap-2 pl-2 pr-1 py-1 rounded-xl hover:bg-zinc-900 transition-colors text-left"
              >
                {currentUser?.avatar ? (
                  <img
                    src={currentUser.avatar}
                    alt={displayName}
                    className="h-8 w-8 rounded-full object-cover border border-zinc-700"
                  />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-zinc-900 border border-zinc-700 flex items-center justify-center font-bold text-xs text-white">
                    {userInitials}
                  </div>
                )}
                <div className="hidden sm:block text-left leading-tight">
                  <span className="text-xs font-semibold text-white block truncate max-w-[120px]">
                    {displayName}
                  </span>
                  <span className="text-[10px] text-emerald-400 font-medium">
                    {formatBytes(maxBytes)} Plan
                  </span>
                </div>
              </button>

              <AnimatePresence>
                {showUserDropdown && (
                  <motion.div
                    initial={{ opacity: 0, y: 8, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.95 }}
                    className="absolute right-0 mt-2 w-64 bg-zinc-950 border border-zinc-800 rounded-2xl p-2 shadow-2xl z-50"
                  >
                    <div className="p-3 border-b border-zinc-900">
                      <span className="text-xs font-bold text-white block">{displayName}</span>
                      <span className="text-[11px] text-zinc-400 truncate block">{displayEmail}</span>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                          {currentPlanName}
                        </span>
                        <button
                          onClick={() => {
                            setShowUserDropdown(false);
                            openUpgradeModal();
                          }}
                          className="text-[10px] text-amber-400 font-semibold hover:underline"
                        >
                          Upgrade Plan →
                        </button>
                      </div>
                    </div>

                    <div className="py-1">
                      <button
                        onClick={() => {
                          setShowUserDropdown(false);
                          openUpgradeModal();
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-amber-400 hover:bg-zinc-900 rounded-lg transition-colors text-left font-semibold"
                      >
                        <Flame className="h-3.5 w-3.5" />
                        <span>Storage Plans (From $3.99)</span>
                      </button>
                      <button
                        onClick={() => {
                          setShowUserDropdown(false);
                          setShowSettings(true);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:text-white hover:bg-zinc-900 rounded-lg transition-colors text-left"
                      >
                        <HardDrive className="h-3.5 w-3.5 text-zinc-400" />
                        <span>Storage Quota & Settings</span>
                      </button>
                      <button
                        onClick={() => {
                          setShowUserDropdown(false);
                          setShowFeedback(true);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:text-white hover:bg-zinc-900 rounded-lg transition-colors text-left"
                      >
                        <MessageSquare className="h-3.5 w-3.5 text-zinc-400" />
                        <span>Send Feedback</span>
                      </button>
                    </div>

                    <div className="pt-1 border-t border-zinc-900">
                      <button
                        onClick={() => {
                          setShowUserDropdown(false);
                          handleLogout();
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors text-left font-medium"
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        <span>Log Out of Vault</span>
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </header>

        {/* Viewport Content */}
        <div className="flex-1 overflow-y-auto p-6 sm:p-8 pt-6">
          {activeCategory === "home" && !searchQuery ? (
            <div className="space-y-6 max-w-7xl mx-auto">
              <div className="p-6 rounded-2xl border border-zinc-900 bg-zinc-950/70 shadow-lg flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                      {currentPlanName}
                    </span>
                    <span className="text-[11px] text-zinc-400">· Backblaze B2 & Firestore Synced</span>
                  </div>
                  <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
                    Photos & Videos Vault
                  </h1>
                  <p className="text-xs text-zinc-400 mt-1">
                    Store camera RAW photos and 4K video clips with zero compression on Backblaze B2.
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="px-3.5 py-2 rounded-xl bg-zinc-900/70 border border-zinc-800 text-right">
                    <div className="text-[10px] text-zinc-400 uppercase font-mono">Used Storage</div>
                    <div className="text-sm font-bold text-white font-mono">{storageCalc.formattedUsed}</div>
                  </div>
                  <div className="px-3.5 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-right">
                    <div className="text-[10px] text-emerald-400 uppercase font-mono">Space Left</div>
                    <div className="text-sm font-bold text-emerald-400 font-mono">{storageCalc.formattedRemaining}</div>
                  </div>
                  <div className="px-3.5 py-2 rounded-xl bg-zinc-900/70 border border-zinc-800 text-right">
                    <div className="text-[10px] text-zinc-400 uppercase font-mono">Total Files</div>
                    <div className="text-sm font-bold text-zinc-200 font-mono">{stats?.totalFiles || 0}</div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-2">
                <div className="flex items-center gap-2">
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => fileInputRef.current?.click()}
                    className="bg-white text-black hover:bg-zinc-200 font-bold text-xs px-4 py-2 rounded-xl transition-all flex items-center gap-1.5 shadow-sm"
                  >
                    <UploadCloud className="h-3.5 w-3.5" />
                    <span>Upload Photos & Videos</span>
                  </motion.button>
                  <button
                    onClick={() => setActiveCategory("photos")}
                    className="px-3 py-2 rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800 text-xs font-medium text-zinc-300 hover:text-white transition-colors flex items-center gap-1.5"
                  >
                    <Camera className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Photos ({stats?.categoryBreakdown?.image?.count || 0})</span>
                  </button>
                  <button
                    onClick={() => setActiveCategory("videos")}
                    className="px-3 py-2 rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800 text-xs font-medium text-zinc-300 hover:text-white transition-colors flex items-center gap-1.5"
                  >
                    <Film className="h-3.5 w-3.5 text-sky-400" />
                    <span>Videos ({stats?.categoryBreakdown?.video?.count || 0})</span>
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {files.length > 0 && (
                    <button
                      onClick={selectAll}
                      className="text-xs text-zinc-300 hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-950 font-medium"
                    >
                      {selectedIds.size === files.length && files.length > 0 ? (
                        <CheckSquare className="h-3.5 w-3.5 text-white" />
                      ) : (
                        <Square className="h-3.5 w-3.5" />
                      )}
                      <span>Select All</span>
                    </button>
                  )}

                  <div className="flex items-center rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
                    <button
                      onClick={() => setViewMode("grid")}
                      className={`p-1.5 rounded-md ${
                        viewMode === "grid" ? "bg-white text-black shadow-sm" : "text-zinc-400 hover:text-white"
                      }`}
                      title="Grid View"
                    >
                      <Grid className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setViewMode("list")}
                      className={`p-1.5 rounded-md ${
                        viewMode === "list" ? "bg-white text-black shadow-sm" : "text-zinc-400 hover:text-white"
                      }`}
                      title="List View"
                    >
                      <List className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as any)}
                    className="bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs rounded-xl px-2.5 py-1.5 focus:outline-none"
                  >
                    <option value="date">Date Uploaded</option>
                    <option value="name">File Name</option>
                    <option value="size">Size</option>
                  </select>
                </div>
              </div>

              {files.length === 0 ? (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="p-12 rounded-2xl border-2 border-dashed border-zinc-800 hover:border-zinc-600 bg-zinc-950/40 text-center cursor-pointer transition-all flex flex-col items-center justify-center my-6"
                >
                  <UploadCloud className="h-10 w-10 text-zinc-500 mb-3" />
                  <h3 className="text-base font-bold text-white">Your Vault is Empty</h3>
                  <p className="text-xs text-zinc-400 mt-1 max-w-sm">
                    Drag and drop photos or 4K videos here to test upload up to your {formatBytes(maxBytes)} plan.
                  </p>
                  <button className="mt-4 bg-white text-black font-semibold text-xs px-4 py-2 rounded-xl">
                    Select Media Files
                  </button>
                </div>
              ) : viewMode === "grid" ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 pt-2">
                  {filteredAndSortedFiles.map((file) => {
                    const isSelected = selectedIds.has(file.id);
                    const effectiveType = file.type && file.type !== "other" ? file.type : detectFileType(file.name, file.mimeType);
                    const isVideo = effectiveType === "video";
                    const isPhoto = effectiveType === "image";
                    const isAudio = effectiveType === "audio";

                    return (
                      <motion.div
                        key={file.id}
                        whileHover={{ y: -3 }}
                        onClick={() => setPreviewFile(file)}
                        className={`group relative rounded-2xl border bg-zinc-950 overflow-hidden cursor-pointer shadow-lg transition-all flex flex-col ${
                          isSelected ? "border-white bg-zinc-900" : "border-zinc-900 hover:border-zinc-700"
                        }`}
                      >
                        {/* Checkbox select top left */}
                        <div
                          onClick={(e) => toggleSelect(file.id, e)}
                          className="absolute top-2.5 left-2.5 z-25 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                        >
                          <div
                            className={`p-1 rounded bg-black/80 border ${
                              isSelected ? "border-white text-white" : "border-zinc-700 text-zinc-400"
                            }`}
                          >
                            {isSelected ? <Check className="h-3 w-3" /> : <Square className="h-3 w-3" />}
                          </div>
                        </div>

                        <div className="aspect-[4/3] w-full bg-zinc-900/90 relative overflow-hidden flex items-center justify-center">
                          {renderGridMediaPreview(file)}

                          <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-30">
                            <button
                              onClick={(e) => toggleFavorite(file, e)}
                              className={`p-1.5 rounded-lg bg-black/60 backdrop-blur-sm border border-white/10 ${
                                file.isFavorite ? "text-amber-400" : "text-white hover:text-amber-400"
                              }`}
                            >
                              <Star className="h-3.5 w-3.5" fill={file.isFavorite ? "currentColor" : "none"} />
                            </button>
                            <button
                              onClick={(e) => downloadFile(file, e)}
                              className="p-1.5 rounded-lg bg-black/60 backdrop-blur-sm border border-white/10 text-white hover:text-zinc-200"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        <div className="p-3 border-t border-zinc-900/80 flex-1 flex flex-col justify-between">
                          <span className="text-xs font-semibold text-white truncate block" title={file.name}>
                            {file.name}
                          </span>
                          <div className="flex items-center justify-between mt-1 text-[11px] text-zinc-400 font-mono">
                            <span>{formatBytes(file.size)}</span>
                            <span>{file.resolution || (file.type === "video" ? "Video" : "Photo")}</span>
                          </div>
                          <div className="mt-2 pt-2 border-t border-zinc-900/60 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenameTarget(file);
                                setNewNameInput(file.name);
                              }}
                              title="Rename File"
                              className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTarget(file);
                              }}
                              title="Delete Permanently"
                              className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-red-400 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-2xl border border-zinc-900 bg-zinc-950 overflow-hidden divide-y divide-zinc-900/80">
                  {filteredAndSortedFiles.map((file) => {
                    const isSelected = selectedIds.has(file.id);
                    return (
                      <div
                        key={file.id}
                        onClick={() => setPreviewFile(file)}
                        className={`px-4 py-3 hover:bg-zinc-900/50 flex items-center justify-between gap-4 cursor-pointer transition-colors ${
                          isSelected ? "bg-zinc-900/80" : ""
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <button onClick={(e) => toggleSelect(file.id, e)} className="shrink-0 text-zinc-400">
                            {isSelected ? (
                              <CheckSquare className="h-4 w-4 text-white" />
                            ) : (
                              <Square className="h-4 w-4" />
                            )}
                          </button>
                          <div className="h-10 w-10 rounded-xl bg-zinc-900 border border-zinc-800 shrink-0 overflow-hidden flex items-center justify-center">
                            {renderListMediaThumb(file, "h-10 w-10")}
                          </div>
                          <div className="min-w-0">
                            <span className="text-sm font-medium text-white truncate block">
                              {file.name}
                            </span>
                            <span className="text-xs text-zinc-400 font-mono">
                              {formatBytes(file.size)} · {formatDate(file.uploadedAt)}
                              {file.resolution && ` · ${file.resolution}`}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          {file.type === "video" && (
                            <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-mono text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20">
                              <Play className="h-3 w-3" /> Play Video
                            </span>
                          )}
                          <button
                            onClick={(e) => toggleFavorite(file, e)}
                            className={`p-1.5 rounded-lg hover:bg-zinc-800 transition-colors ${
                              file.isFavorite ? "text-amber-400" : "text-zinc-400 hover:text-white"
                            }`}
                          >
                            <Star className="h-4 w-4" fill={file.isFavorite ? "currentColor" : "none"} />
                          </button>
                          <button
                            onClick={(e) => downloadFile(file, e)}
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                          >
                            <Download className="h-4 w-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameTarget(file);
                              setNewNameInput(file.name);
                            }}
                            title="Rename"
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget(file);
                            }}
                            title="Delete Permanently"
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6 max-w-7xl mx-auto">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-2xl font-bold tracking-tight capitalize">
                    {activeCategory}
                  </h2>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400 tabular-nums">
                    {filteredAndSortedFiles.length} item{filteredAndSortedFiles.length === 1 ? "" : "s"}
                  </span>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {[
                    { id: "all", label: "All" },
                    { id: "photos", label: "📸 Photos" },
                    { id: "videos", label: "🎥 Videos" },
                    { id: "audio", label: "🎵 Audio" },
                    { id: "documents", label: "📁 Docs" },
                    { id: "archives", label: "📦 Archives" },
                    { id: "favorites", label: "⭐ Starred" },
                  ].map((chip) => (
                    <button
                      key={chip.id}
                      onClick={() => setActiveCategory(chip.id as FileCategory)}
                      className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                        activeCategory === chip.id
                          ? "bg-white text-black border-white font-semibold"
                          : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-white hover:bg-zinc-900"
                      }`}
                    >
                      {chip.label}
                    </button>
                  ))}

                  <button
                    onClick={selectAll}
                    className="text-xs text-zinc-300 hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-950 ml-2 font-medium"
                  >
                    {selectedIds.size === filteredAndSortedFiles.length && filteredAndSortedFiles.length > 0 ? (
                      <CheckSquare className="h-3.5 w-3.5 text-white" />
                    ) : (
                      <Square className="h-3.5 w-3.5" />
                    )}
                    <span>Select All</span>
                  </button>
                </div>
              </div>

              {filteredAndSortedFiles.length === 0 ? (
                <div className="py-20 text-center flex flex-col items-center justify-center border border-dashed border-zinc-800 rounded-3xl bg-zinc-950/40">
                  {activeCategory === "photos" ? (
                    <Camera className="h-12 w-12 text-emerald-400 mb-3" />
                  ) : activeCategory === "videos" ? (
                    <Film className="h-12 w-12 text-sky-400 mb-3" />
                  ) : activeCategory === "audio" ? (
                    <Music className="h-12 w-12 text-purple-400 mb-3" />
                  ) : activeCategory === "archives" ? (
                    <Archive className="h-12 w-12 text-indigo-400 mb-3" />
                  ) : activeCategory === "documents" ? (
                    <FileText className="h-12 w-12 text-amber-400 mb-3" />
                  ) : (
                    <Files className="h-12 w-12 text-zinc-400 mb-3" />
                  )}
                  <h3 className="text-lg font-semibold text-white">No files found</h3>
                  <p className="text-zinc-400 text-sm max-w-sm mt-1">
                    {searchQuery
                      ? "No files matched your search query. Try another keyword."
                      : "Start storing your photos and videos by uploading them now."}
                  </p>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-5 bg-white text-black hover:bg-zinc-200 font-semibold text-sm px-5 py-2.5 rounded-xl transition-all"
                  >
                    Upload Files
                  </button>
                </div>
              ) : viewMode === "grid" ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {filteredAndSortedFiles.map((file) => {
                    const isSelected = selectedIds.has(file.id);

                    return (
                      <motion.div
                        key={file.id}
                        whileHover={{ y: -4 }}
                        onClick={() => setPreviewFile(file)}
                        className={`group relative rounded-2xl border p-3 flex flex-col justify-between transition-all cursor-pointer bg-zinc-950 hover:bg-zinc-900/80 ${
                          isSelected ? "border-white bg-zinc-900" : "border-zinc-900 hover:border-zinc-700"
                        }`}
                      >
                        <div
                          onClick={(e) => toggleSelect(file.id, e)}
                          className="absolute top-2.5 left-2.5 z-20 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                        >
                          <div
                            className={`p-1 rounded bg-black/80 border ${
                              isSelected ? "border-white text-white" : "border-zinc-700 text-zinc-400"
                            }`}
                          >
                            {isSelected ? <Check className="h-3 w-3" /> : <Square className="h-3 w-3" />}
                          </div>
                        </div>

                        <div className="absolute top-2.5 right-2.5 z-20">
                          <button
                            onClick={(e) => toggleFavorite(file, e)}
                            className={`p-1.5 rounded-lg bg-black/60 hover:bg-black/90 transition-colors ${
                              file.isFavorite ? "text-amber-400" : "text-zinc-400 opacity-0 group-hover:opacity-100"
                            }`}
                          >
                            <Star className="h-3.5 w-3.5" fill={file.isFavorite ? "currentColor" : "none"} />
                          </button>
                        </div>

                        <div className="w-full h-36 rounded-xl bg-zinc-900/90 border border-zinc-800/80 flex items-center justify-center overflow-hidden mb-3 relative">
                          {renderGridMediaPreview(file)}
                        </div>

                        <div className="min-w-0">
                          <span className="text-xs font-semibold text-white truncate block" title={file.name}>
                            {file.name}
                          </span>
                          <div className="flex items-center justify-between text-[11px] text-zinc-400 mt-1 font-mono">
                            <span>{formatBytes(file.size)}</span>
                            <span>{formatDate(file.uploadedAt)}</span>
                          </div>
                        </div>

                        <div className="mt-3 pt-2.5 border-t border-zinc-900 flex items-center justify-end gap-1">
                          <button
                            onClick={(e) => downloadFile(file, e)}
                            title="Download"
                            className="p-1 rounded text-zinc-400 hover:text-white"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameTarget(file);
                              setNewNameInput(file.name);
                            }}
                            title="Rename"
                            className="p-1 rounded text-zinc-400 hover:text-white"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget(file);
                            }}
                            title="Delete Permanently"
                            className="p-1 rounded text-zinc-400 hover:text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-2xl border border-zinc-900 bg-zinc-950 overflow-hidden">
                  <div className="grid grid-cols-12 px-4 py-2.5 border-b border-zinc-900 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                    <div className="col-span-6 flex items-center gap-3">
                      <button onClick={selectAll}>
                        {selectedIds.size === filteredAndSortedFiles.length && filteredAndSortedFiles.length > 0 ? (
                          <CheckSquare className="h-3.5 w-3.5 text-white" />
                        ) : (
                          <Square className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <span>Name</span>
                    </div>
                    <div className="col-span-2">Format</div>
                    <div className="col-span-2">Size</div>
                    <div className="col-span-2 text-right">Actions</div>
                  </div>

                  {filteredAndSortedFiles.map((file) => {
                    const isSelected = selectedIds.has(file.id);
                    return (
                      <div
                        key={file.id}
                        onClick={() => setPreviewFile(file)}
                        className={`grid grid-cols-12 px-4 py-3 border-b border-zinc-900/80 last:border-b-0 items-center text-sm cursor-pointer transition-colors ${
                          isSelected ? "bg-zinc-900" : "hover:bg-zinc-900/50"
                        }`}
                      >
                        <div className="col-span-6 flex items-center gap-3 min-w-0">
                          <button onClick={(e) => toggleSelect(file.id, e)} className="shrink-0 text-zinc-400">
                            {isSelected ? (
                              <CheckSquare className="h-3.5 w-3.5 text-white" />
                            ) : (
                              <Square className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <div className="h-8 w-8 rounded-lg bg-zinc-900 border border-zinc-800 shrink-0 overflow-hidden flex items-center justify-center">
                            {renderListMediaThumb(file, "h-8 w-8")}
                          </div>
                          <div className="min-w-0 truncate">
                            <span className="font-medium text-white truncate block">{file.name}</span>
                            {file.resolution && (
                              <span className="text-[10px] text-zinc-500 font-mono block">
                                {file.resolution}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="col-span-2 text-xs text-zinc-400 uppercase font-mono">
                          {file.type}
                        </div>

                        <div className="col-span-2 text-xs text-zinc-400 font-mono">
                          {formatBytes(file.size)}
                        </div>

                        <div className="col-span-2 flex items-center justify-end gap-2">
                          <button
                            onClick={(e) => toggleFavorite(file, e)}
                            className={`p-1.5 rounded ${
                              file.isFavorite ? "text-amber-400" : "text-zinc-400 hover:text-white"
                            }`}
                          >
                            <Star className="h-4 w-4" fill={file.isFavorite ? "currentColor" : "none"} />
                          </button>
                          <button
                            onClick={(e) => downloadFile(file, e)}
                            className="p-1.5 rounded text-zinc-400 hover:text-white"
                          >
                            <Download className="h-4 w-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameTarget(file);
                              setNewNameInput(file.name);
                            }}
                            className="p-1.5 rounded text-zinc-400 hover:text-white"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget(file);
                            }}
                            title="Delete Permanently"
                            className="p-1.5 rounded text-zinc-400 hover:text-red-400"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* FLOATING MULTI-SELECT ACTION BAR (TOAST) */}
        <AnimatePresence>
          {selectedIds.size > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 30 }}
              className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-zinc-900 border border-zinc-700 px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-4 text-sm"
            >
              <span className="font-semibold text-white">
                {selectedIds.size} file{selectedIds.size > 1 ? "s" : ""} selected
              </span>
              <div className="h-4 w-px bg-zinc-700" />
              <button
                onClick={handleBulkDownload}
                className="text-white hover:text-zinc-200 flex items-center gap-1.5 font-medium"
              >
                <Download className="h-4 w-4" /> Download
              </button>
              <button
                onClick={handleBulkDelete}
                className="text-red-400 hover:text-red-300 flex items-center gap-1.5 font-medium"
              >
                <Trash2 className="h-4 w-4" /> Delete
              </button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-zinc-400 hover:text-white ml-2"
              >
                <X className="h-4 w-4" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* PREVIEW MODAL */}
        <AnimatePresence>
          {previewFile && (
            <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94 }}
                className="bg-zinc-950 border border-zinc-800 rounded-3xl max-w-3xl w-full p-6 shadow-2xl relative flex flex-col max-h-[90vh]"
              >
                <button
                  onClick={() => setPreviewFile(null)}
                  className="absolute top-5 right-5 text-zinc-400 hover:text-white z-10 p-1 rounded-lg hover:bg-zinc-900 transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>

                <div className="flex items-center gap-3 mb-4 pr-10">
                  <div className="p-2.5 rounded-xl bg-zinc-900 border border-zinc-800 shrink-0">
                    {renderFileIcon(previewFile, "h-6 w-6")}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-lg font-bold text-white truncate">{previewFile.name}</h3>
                    <p className="text-xs text-zinc-400 font-mono">
                      {formatBytes(previewFile.size)} · {previewFile.mimeType}
                      {previewFile.resolution && ` · ${previewFile.resolution}`}
                      {previewFile.duration && ` · Duration: ${previewFile.duration}`}
                    </p>
                  </div>
                </div>

                <div className="flex-1 min-h-[300px] max-h-[500px] rounded-2xl bg-black border border-zinc-900 flex items-center justify-center overflow-hidden mb-4 relative">
                  {previewFile.type === "video" ? (
                    <video
                      controls
                      autoPlay
                      playsInline
                      src={previewFile.previewUrl || previewFile.url || `/api/files/${previewFile.id}`}
                      poster={previewFile.thumbnailUrl || undefined}
                      className="max-h-full max-w-full rounded-xl"
                    >
                      Your browser does not support HTML5 video streaming.
                    </video>
                  ) : previewFile.type === "image" ? (
                    <img
                      src={previewFile.thumbnailUrl || previewFile.contentBase64 || previewFile.url || `/api/files/${previewFile.id}`}
                      alt={previewFile.name}
                      className="max-h-full max-w-full object-contain rounded-xl"
                    />
                  ) : previewFile.type === "audio" ? (
                    <div className="p-8 text-center w-full">
                      <Music className="h-16 w-16 text-zinc-400 mx-auto mb-4" />
                      <audio controls className="w-full max-w-md mx-auto" src={previewFile.url || `/api/files/${previewFile.id}`} />
                    </div>
                  ) : previewFile.type === "archive" ? (
                    <div className="text-center p-8 text-zinc-400">
                      <div className="h-20 w-20 mx-auto mb-4 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                        <Archive className="h-10 w-10" />
                      </div>
                      <p className="text-base font-bold text-white mb-1">{previewFile.name}</p>
                      <span className="inline-block text-xs font-mono px-2.5 py-1 rounded bg-indigo-950 text-indigo-300 border border-indigo-500/30 mb-3">
                        Compressed Archive Bundle ({formatBytes(previewFile.size)})
                      </span>
                      <p className="text-xs text-zinc-400 max-w-sm mx-auto">
                        This compressed archive is preserved in its original byte structure with AES-256 cloud encryption.
                      </p>
                    </div>
                  ) : previewFile.type === "document" ? (
                    <div className="text-center p-8 text-zinc-400">
                      <div className="h-20 w-20 mx-auto mb-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
                        <FileText className="h-10 w-10" />
                      </div>
                      <p className="text-base font-bold text-white mb-1">{previewFile.name}</p>
                      <span className="inline-block text-xs font-mono px-2.5 py-1 rounded bg-amber-950 text-amber-300 border border-amber-500/30 mb-3">
                        Document · {previewFile.mimeType}
                      </span>
                      <p className="text-xs text-zinc-400 max-w-sm mx-auto">
                        Document file ready for download and local viewing.
                      </p>
                    </div>
                  ) : previewFile.type === "code" ? (
                    <div className="text-center p-8 text-zinc-400">
                      <div className="h-20 w-20 mx-auto mb-4 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                        <FileCode className="h-10 w-10" />
                      </div>
                      <p className="text-base font-bold text-white mb-1">{previewFile.name}</p>
                      <span className="inline-block text-xs font-mono px-2.5 py-1 rounded bg-cyan-950 text-cyan-300 border border-cyan-500/30 mb-3">
                        Source Code File · {previewFile.name.split('.').pop()?.toUpperCase()}
                      </span>
                    </div>
                  ) : (
                    <div className="text-center p-6 text-zinc-400">
                      <Info className="h-8 w-8 mx-auto mb-2 text-zinc-400" />
                      <p className="text-sm font-semibold text-white">{previewFile.name}</p>
                      <p className="text-xs text-zinc-400 mt-1 font-mono">
                        Stored in secure permanent CloudValt {currentPlanName} storage.
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between border-t border-zinc-900 pt-4">
                  <div className="text-xs text-zinc-400 font-mono">
                    <div>Uploaded: {formatDate(previewFile.uploadedAt)}</div>
                    {previewFile.b2FileName && (
                      <div className="text-[10px] text-zinc-500 truncate max-w-sm">
                        Backblaze B2: {previewFile.b2FileName}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => downloadFile(previewFile)}
                      className="bg-white text-black hover:bg-zinc-200 font-semibold text-xs px-4 py-2 rounded-xl flex items-center gap-1.5 shadow-md shadow-white/5"
                    >
                      <Download className="h-3.5 w-3.5" /> Download Original
                    </button>
                    <button
                      onClick={() => setPreviewFile(null)}
                      className="border border-zinc-800 hover:bg-zinc-900 text-white text-xs px-4 py-2 rounded-xl transition-colors"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* PLAN UPGRADE MODAL */}
        <AnimatePresence>
          {showUpgradeModal && (
            <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94 }}
                className="bg-zinc-950 border border-zinc-800 rounded-3xl max-w-3xl w-full p-6 sm:p-8 shadow-2xl relative"
              >
                <button
                  onClick={() => setShowUpgradeModal(false)}
                  className="absolute top-5 right-5 text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-900"
                >
                  <X className="h-5 w-5" />
                </button>

                <div className="text-center max-w-lg mx-auto mb-8">
                  {upgradeReason && (
                    <div className="mb-5 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-300 flex items-start gap-3 text-left shadow-lg">
                      <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-amber-200">Storage Plan Limit Exceeded</h4>
                        <p className="text-xs text-amber-300/90 mt-1 leading-relaxed">{upgradeReason}</p>
                      </div>
                    </div>
                  )}

                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-semibold mb-2">
                    <Flame className="h-3.5 w-3.5" />
                    <span>Instant CloudValt Storage Upgrade</span>
                  </div>
                  <h3 className="text-2xl sm:text-3xl font-extrabold text-white">
                    Upgrade Your Vault Quota
                  </h3>
                  <p className="text-xs sm:text-sm text-zinc-400 mt-1">
                    Currently on <strong className="text-white">{currentPlanName}</strong>. Select a high-capacity tier for your photos and 4K videos.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                  {/* 100 MB Free Tier */}
                  <motion.div
                    whileHover={{ y: -3 }}
                    className={`p-4 rounded-2xl border ${
                      currentUser?.planId === "100mb" || !currentUser?.planId
                        ? "border-emerald-500/80 bg-emerald-500/5"
                        : "border-zinc-800 bg-zinc-900/50"
                    } flex flex-col justify-between`}
                  >
                    <div>
                      <span className="text-[10px] uppercase font-bold text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded border border-zinc-700">
                        Test Mode
                      </span>
                      <h4 className="text-lg font-bold text-white mt-2">100 MB</h4>
                      <p className="text-[11px] text-zinc-400 mt-0.5">Test upload & RAW zero-loss</p>
                      <div className="mt-2 text-xl font-black text-white">
                        $0 <span className="text-xs text-zinc-500 font-normal">/ free</span>
                      </div>
                      <div className="mt-2 p-2 rounded-lg bg-zinc-950/70 border border-zinc-800/80">
                        <div className="text-[10px] text-zinc-400">Space left on this tier:</div>
                        <div className="text-xs font-bold text-emerald-400 font-mono">
                          {formatExactBytes(Math.max(0, 100 * 1024 * 1024 - usedBytes))} left
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleUpgradePlan("100mb")}
                      disabled={currentUser?.planId === "100mb" || !currentUser?.planId}
                      className="mt-4 w-full bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white font-bold text-xs py-2 rounded-xl transition-all"
                    >
                      {currentUser?.planId === "100mb" || !currentUser?.planId ? "Current Tier" : "Select 100 MB"}
                    </button>
                  </motion.div>

                  {/* 50 GB Starter */}
                  <motion.div
                    whileHover={{ y: -3 }}
                    className={`p-4 rounded-2xl border ${
                      currentUser?.planId === "50gb"
                        ? "border-emerald-500/80 bg-emerald-500/5"
                        : "border-zinc-800 bg-zinc-900/50"
                    } flex flex-col justify-between`}
                  >
                    <div>
                      <span className="text-[10px] uppercase font-bold text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20">
                        Starter Creator
                      </span>
                      <h4 className="text-lg font-bold text-white mt-2">50 GB</h4>
                      <p className="text-[11px] text-zinc-400 mt-0.5">~12,500 photos & 4K clips</p>
                      <div className="mt-2 text-xl font-black text-white">
                        $3.99 <span className="text-xs text-zinc-500 font-normal">/ mo</span>
                      </div>
                      <div className="mt-2 p-2 rounded-lg bg-zinc-950/70 border border-zinc-800/80">
                        <div className="text-[10px] text-zinc-400">Space left on this tier:</div>
                        <div className="text-xs font-bold text-emerald-400 font-mono">
                          {formatExactBytes(Math.max(0, 50 * 1024 * 1024 * 1024 - usedBytes))} left
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleUpgradePlan("50gb")}
                      className="mt-4 w-full bg-white text-black hover:bg-zinc-200 font-bold text-xs py-2 rounded-xl transition-all"
                    >
                      {currentUser?.planId === "50gb" ? "Current Tier" : "Select 50 GB"}
                    </button>
                  </motion.div>

                  {/* 250 GB Pro Studio */}
                  <motion.div
                    whileHover={{ y: -4 }}
                    className={`p-4 rounded-2xl border-2 ${
                      currentUser?.planId === "250gb"
                        ? "border-emerald-400 bg-emerald-500/10"
                        : "border-emerald-500 bg-gradient-to-b from-zinc-900 to-zinc-950"
                    } flex flex-col justify-between relative shadow-xl shadow-emerald-500/10`}
                  >
                    <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-emerald-500 text-black text-[9px] font-extrabold uppercase">
                      Most Popular
                    </div>
                    <div>
                      <span className="text-[10px] uppercase font-bold text-emerald-400 bg-emerald-500/20 px-2 py-0.5 rounded border border-emerald-500/30">
                        Pro Studio
                      </span>
                      <h4 className="text-lg font-bold text-white mt-2">250 GB</h4>
                      <p className="text-[11px] text-zinc-400 mt-0.5">~62,500 photos / 50h 4K</p>
                      <div className="mt-2 text-xl font-black text-white">
                        $6.99 <span className="text-xs text-zinc-500 font-normal">/ mo</span>
                      </div>
                      <div className="mt-2 p-2 rounded-lg bg-zinc-950/70 border border-zinc-800/80">
                        <div className="text-[10px] text-zinc-400">Space left on this tier:</div>
                        <div className="text-xs font-bold text-emerald-400 font-mono">
                          {formatExactBytes(Math.max(0, 250 * 1024 * 1024 * 1024 - usedBytes))} left
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleUpgradePlan("250gb")}
                      className="mt-4 w-full bg-emerald-400 hover:bg-emerald-300 text-black font-extrabold text-xs py-2 rounded-xl transition-all shadow-md shadow-emerald-400/20"
                    >
                      {currentUser?.planId === "250gb" ? "Current Tier" : "Select 250 GB"}
                    </button>
                  </motion.div>

                  {/* 1 TB Ultimate */}
                  <motion.div
                    whileHover={{ y: -3 }}
                    className={`p-4 rounded-2xl border ${
                      currentUser?.planId === "1tb"
                        ? "border-purple-400 bg-purple-500/10"
                        : "border-zinc-800 bg-zinc-900/50"
                    } flex flex-col justify-between`}
                  >
                    <div>
                      <span className="text-[10px] uppercase font-bold text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">
                        Ultimate Archive
                      </span>
                      <h4 className="text-lg font-bold text-white mt-2">1 TB</h4>
                      <p className="text-[11px] text-zinc-400 mt-0.5">1,000 GB complete studio</p>
                      <div className="mt-2 text-xl font-black text-white">
                        $13.99 <span className="text-xs text-zinc-500 font-normal">/ mo</span>
                      </div>
                      <div className="mt-2 p-2 rounded-lg bg-zinc-950/70 border border-zinc-800/80">
                        <div className="text-[10px] text-zinc-400">Space left on this tier:</div>
                        <div className="text-xs font-bold text-emerald-400 font-mono">
                          {formatExactBytes(Math.max(0, 1024 * 1024 * 1024 * 1024 - usedBytes))} left
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleUpgradePlan("1tb")}
                      className="mt-4 w-full bg-white text-black hover:bg-zinc-200 font-bold text-xs py-2 rounded-xl transition-all"
                    >
                      {currentUser?.planId === "1tb" ? "Current Tier" : "Select 1 TB"}
                    </button>
                  </motion.div>
                </div>

                <div className="flex items-center justify-between text-xs text-zinc-500 border-t border-zinc-900 pt-4">
                  <span>Synced with Firebase Firestore (cloudvalt.site)</span>
                  <button
                    onClick={() => setShowUpgradeModal(false)}
                    className="text-zinc-400 hover:text-white"
                  >
                    Cancel
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* RENAME MODAL */}
        {renameTarget && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-zinc-950 border border-zinc-800 rounded-3xl max-w-md w-full p-6 shadow-2xl">
              <h3 className="text-lg font-bold text-white mb-2">Rename File</h3>
              <p className="text-xs text-zinc-400 mb-4">Enter a new name for this media file in your vault.</p>
              <form onSubmit={handleRenameSubmit} className="space-y-4">
                <input
                  type="text"
                  value={newNameInput}
                  onChange={(e) => setNewNameInput(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-white"
                  autoFocus
                  required
                />
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setRenameTarget(null)}
                    className="px-4 py-2 text-xs rounded-lg border border-zinc-800 hover:bg-zinc-900 text-zinc-300"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs rounded-lg bg-white text-black hover:bg-zinc-200 font-semibold"
                  >
                    Save Name
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* DELETE CONFIRMATION MODAL */}
        {deleteTarget && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-zinc-950 border border-zinc-800 rounded-3xl max-w-md w-full p-6 shadow-2xl">
              <h3 className="text-lg font-bold text-white mb-2">
                Permanently Delete File?
              </h3>
              <p className="text-xs text-zinc-400 mb-6 leading-relaxed">
                Are you sure you want to permanently delete <strong className="text-white">"{deleteTarget.name}"</strong>? This file will be immediately purged from your vault and Backblaze B2 cloud storage. This action cannot be undone.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  className="px-4 py-2 text-xs rounded-lg border border-zinc-800 hover:bg-zinc-900 text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmDelete}
                  className="px-4 py-2 text-xs rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold flex items-center gap-1.5 shadow-sm"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Delete Permanently</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* SETTINGS MODAL */}
        {showSettings && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-zinc-950 border border-zinc-800 rounded-3xl max-w-lg w-full p-6 shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <HardDrive className="h-5 w-5" /> Storage Plan & Settings
                </h3>
                <button onClick={() => setShowSettings(false)} className="text-zinc-400 hover:text-white">
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="p-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 mb-6">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-zinc-400">Current Plan</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20">
                    {currentPlanName} Active
                  </span>
                </div>
                <div className="text-2xl font-bold tracking-tight text-white mt-2 font-mono">
                  {storageCalc.formattedUsed} <span className="text-xs text-zinc-400 font-normal">used of {storageCalc.formattedMax}</span>
                </div>
                <div className="w-full bg-zinc-800 h-2 rounded-full overflow-hidden mt-3">
                  <div className="bg-emerald-400 h-full rounded-full transition-all duration-500" style={{ width: `${storageCalc.usedPercentage}%` }} />
                </div>
                <div className="mt-2 text-[11px] text-zinc-300 flex justify-between font-mono">
                  <span className="text-emerald-400 font-semibold">{storageCalc.formattedRemaining} Available</span>
                  <span>{stats?.totalFiles || 0} Synced Files</span>
                </div>

                <button
                  onClick={() => {
                    setShowSettings(false);
                    openUpgradeModal();
                  }}
                  className="mt-4 w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-extrabold text-xs py-2 rounded-xl transition-all flex items-center justify-center gap-1.5"
                >
                  <Flame className="h-4 w-4" />
                  <span>Upgrade to 50 GB ($3.99), 250 GB ($6.99) or 1 TB ($13.99)</span>
                </button>
              </div>

              <div className="space-y-3 text-xs text-zinc-400 border-t border-zinc-900 pt-4">
                <div className="flex justify-between py-1 border-b border-zinc-900/60">
                  <span>User Account</span>
                  <span className="font-semibold text-zinc-200">{displayName}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-zinc-900/60">
                  <span>Email</span>
                  <span className="font-mono text-zinc-300">{displayEmail}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-zinc-900/60">
                  <span>File Storage Engine</span>
                  <span className="text-emerald-400 font-semibold">Backblaze B2 (S3-Compatible)</span>
                </div>
                <div className="flex justify-between py-1 border-b border-zinc-900/60">
                  <span>Database Tables</span>
                  <span className="text-emerald-400 font-semibold">Firestore /users & /files</span>
                </div>
                <div className="flex justify-between py-1">
                  <span>Encryption Standard</span>
                  <span className="text-zinc-300">AES-256 Server Encrypted</span>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-zinc-900 flex justify-between items-center">
                <button
                  onClick={() => {
                    setShowSettings(false);
                    handleLogout();
                  }}
                  className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1.5"
                >
                  <LogOut className="h-3.5 w-3.5" /> Log Out
                </button>
                <button
                  onClick={() => setShowSettings(false)}
                  className="bg-white text-black hover:bg-zinc-200 font-semibold text-xs px-4 py-2 rounded-lg"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {/* FEEDBACK MODAL */}
        {showFeedback && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-zinc-950 border border-zinc-800 rounded-3xl max-w-md w-full p-6 shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <MessageSquare className="h-5 w-5" /> Send Feedback
                </h3>
                <button onClick={() => setShowFeedback(false)} className="text-zinc-400 hover:text-white">
                  <X className="h-5 w-5" />
                </button>
              </div>

              {feedbackSent ? (
                <div className="py-8 text-center">
                  <Check className="h-10 w-10 text-emerald-400 mx-auto mb-3" />
                  <h4 className="text-base font-bold text-white">Thank You!</h4>
                  <p className="text-xs text-zinc-400 mt-1">Your feedback helps improve CloudValt.</p>
                  <button
                    onClick={() => {
                      setShowFeedback(false);
                      setFeedbackSent(false);
                      setFeedbackText("");
                    }}
                    className="mt-5 bg-white text-black font-semibold text-xs px-4 py-2 rounded-lg"
                  >
                    Close
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="text-xs text-zinc-400 block mb-2">Rating</label>
                    <div className="flex items-center gap-2">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          type="button"
                          onClick={() => setFeedbackRating(star)}
                          className={`p-1.5 rounded-lg border ${
                            star <= feedbackRating
                              ? "bg-amber-400/10 border-amber-400/30 text-amber-400"
                              : "border-zinc-800 text-zinc-600 hover:text-zinc-400"
                          }`}
                        >
                          <Star className="h-5 w-5" fill={star <= feedbackRating ? "currentColor" : "none"} />
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-zinc-400 block mb-1.5">Your Thoughts</label>
                    <textarea
                      rows={4}
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      placeholder="Tell us what you like or what could be improved for photo and video storage..."
                      className="w-full bg-zinc-900 border border-zinc-700 rounded-xl p-3 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-white resize-none"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowFeedback(false)}
                      className="px-4 py-2 text-xs rounded-lg border border-zinc-800 hover:bg-zinc-900 text-zinc-300"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowFeedback(true)}
                      className="px-4 py-2 text-xs rounded-lg bg-white text-black hover:bg-zinc-200 font-semibold"
                    >
                      Submit Feedback
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}