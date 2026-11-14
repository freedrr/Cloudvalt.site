import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  type User as FirebaseUser,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  query,
  where,
  orderBy,
  getDocs,
  getDocFromServer,
  serverTimestamp,
} from "firebase/firestore";
import firebaseConfig from "../../firebase-applet-config.json";
import { STORAGE_PLANS } from "./plans";
import { CloudFile, FileCategory, FileType, StorageStats } from "./types";
import { calculateStorage, formatExactBytes } from "./storageCalc";

// Initialize Firebase App
export const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

export async function saveUserFeedback(
  userId: string,
  userEmail: string | undefined,
  rating: number,
  message: string
): Promise<void> {
  const cleanMessage = message.trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error("Please choose a rating from 1 to 5.");
  }
  if (!cleanMessage || cleanMessage.length > 2000) {
    throw new Error("Feedback must be between 1 and 2,000 characters.");
  }
  await addDoc(collection(db, "users", userId, "feedback"), {
    userId,
    userEmail: userEmail || null,
    rating,
    message: cleanMessage,
    createdAt: new Date().toISOString(),
  });
}

// Google Auth Provider
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

// Firestore Error Handler as mandated by Skill
export enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((p) => ({
          providerId: p.providerId,
          email: p.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error("Firestore Error: ", JSON.stringify(errInfo));
  console.trace("Firestore error trace");
  throw new Error(JSON.stringify(errInfo));
}

// Test Connection on bootstrap safely without unhandled rejections
if (typeof window !== "undefined") {
  async function testConnection() {
    try {
      await getDocFromServer(doc(db, "test", "connection"));
    } catch (error: any) {
      if (error?.message?.includes("the client is offline")) {
        console.warn("Please check your Firebase configuration: client is offline.");
      }
    }
  }
  testConnection().catch(() => {});
}

export interface FirestoreUserProfile {
  uid: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  role: string;
  plan: "100 MB Free" | "50 GB" | "250 GB" | "1 TB";
  maxStorageBytes: number;
  usedStorageBytes: number;
  createdAt: string;
  updatedAt: string;
}

// User Document Path in Firestore
function userDocPath(uid: string) {
  return `users/${uid}`;
}

export async function fetchUserProfile(uid: string): Promise<FirestoreUserProfile | null> {
  const path = userDocPath(uid);
  try {
    const userRef = doc(db, "users", uid);
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      return snap.data() as FirestoreUserProfile;
    }
    return null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function createOrUpdateUserProfile(
  user: FirebaseUser,
  customDisplayName?: string,
  chosenPlanId: "100mb" | "50gb" | "250gb" | "1tb" = "100mb"
): Promise<FirestoreUserProfile> {
  const path = userDocPath(user.uid);
  const now = new Date().toISOString();
  const planInfo = STORAGE_PLANS[chosenPlanId] || STORAGE_PLANS["100mb"];

  try {
    const userRef = doc(db, "users", user.uid);
    const existingSnap = await getDoc(userRef);

    if (existingSnap.exists()) {
      const existing = existingSnap.data() as FirestoreUserProfile;
      return existing;
    }

    const newProfile: FirestoreUserProfile = {
      uid: user.uid,
      email: user.email || "user@cloudvalt.site",
      displayName: customDisplayName || user.displayName || user.email?.split("@")[0] || "Vault Creator",
      avatarUrl: user.photoURL || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(user.email || "CV")}`,
      role: "Visual Creator",
      plan: chosenPlanId === "100mb" ? "100 MB Free" : (chosenPlanId === "50gb" ? "50 GB" : chosenPlanId === "250gb" ? "250 GB" : "1 TB"),
      maxStorageBytes: planInfo.maxBytes,
      usedStorageBytes: 0,
      createdAt: now,
      updatedAt: now,
    };

    await setDoc(userRef, newProfile);
    return newProfile;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function updateUserStoragePlan(
  uid: string,
  planId: "100mb" | "50gb" | "250gb" | "1tb"
): Promise<FirestoreUserProfile | null> {
  const path = userDocPath(uid);
  const planInfo = STORAGE_PLANS[planId];
  if (!planInfo) return null;

  try {
    const userRef = doc(db, "users", uid);
    const planName = planId === "100mb" ? "100 MB Free" : (planId === "50gb" ? "50 GB" : planId === "250gb" ? "250 GB" : "1 TB");
    const updateData = {
      plan: planName,
      maxStorageBytes: planInfo.maxBytes,
      updatedAt: new Date().toISOString(),
    };
    await updateDoc(userRef, updateData);
    const updatedSnap = await getDoc(userRef);
    return (updatedSnap.data() as FirestoreUserProfile) || null;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function getUserStoragePlanLimit(userId: string): Promise<number | null> {
  try {
    const snapshot = await getDoc(doc(db, "users", userId));
    if (!snapshot.exists()) return null;
    const limit = Number(snapshot.data().maxStorageBytes);
    return Number.isFinite(limit) && limit > 0 ? limit : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, userDocPath(userId));
  }
}


// Sync user total storage and file count to user document
export async function syncUserStorageStats(
  userId: string
): Promise<{ storageUsed: number; storageRemaining: number; fileCount: number }> {
  const userRef = doc(db, "users", userId);

  try {
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      return {
        storageUsed: 0,
        storageRemaining: 100 * 1024 * 1024,
        fileCount: 0,
      };
    }
    const userData = userSnap.data();
    const maxBytes = Number(userData?.maxStorageBytes) || 100 * 1024 * 1024;

    const filesColl = collection(db, "users", userId, "files");
    const snap = await getDocs(filesColl);

    let storageUsed = 0;
    let fileCount = 0;

    snap.forEach((d) => {
      const data = d.data();

      if (!data.isFolder) {
        storageUsed += Number(data.size) || 0;
        if (!data.isDeleted) fileCount += 1;
      }
    });

    const calc = calculateStorage(storageUsed, maxBytes);

    await updateDoc(userRef, {
      usedStorageBytes: storageUsed,
      storageUsed: storageUsed,
      storageRemaining: calc.remainingBytes,
      storageUsedFormatted: calc.formattedUsed,
      storageRemainingFormatted: calc.formattedRemaining,
      fileCount: fileCount,
      updatedAt: new Date().toISOString(),
    });

    return {
      storageUsed,
      storageRemaining: calc.remainingBytes,
      fileCount,
    };
  } catch (err) {
    console.warn("Storage stats sync:", err);

    return {
      storageUsed: 0,
      storageRemaining: 0,
      fileCount: 0,
    };
  }
}

export function detectFileType(fileName: string, mimeType: string = ""): FileType {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const mime = mimeType.toLowerCase();

  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp", "heic", "heif"].includes(ext) || mime.startsWith("image/")) {
    return "image";
  }
  if (["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "3gp", "flv"].includes(ext) || mime.startsWith("video/")) {
    return "video";
  }
  if (["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "opus"].includes(ext) || mime.startsWith("audio/")) {
    return "audio";
  }
  if (["pdf", "doc", "docx", "txt", "rtf", "odt", "csv", "xls", "xlsx", "ppt", "pptx", "md"].includes(ext) || mime.includes("pdf") || mime.includes("word") || mime.includes("text")) {
    return "document";
  }
  if (["zip", "rar", "7z", "tar", "gz", "bz2"].includes(ext)) {
    return "archive";
  }
  if (["js", "ts", "tsx", "jsx", "json", "html", "css", "py", "go", "rs", "c", "cpp"].includes(ext)) {
    return "code";
  }
  return "other";
}

// Save uploaded file into Firestore users/{userId}/files/{fileId}
// AND separate root files/{fileId}
export async function saveUserFileToFirestore(
  userId: string,
  userEmail: string,
  file: CloudFile
): Promise<CloudFile> {
  if (file.isFolder) {
    return saveUserFolderToFirestore(userId, userEmail, file);
  }
  const fileId = file.id;
  const path = `users/${userId}/files/${fileId}`;
  const now = new Date().toISOString();

  const b2FileName = file.b2FileName || null;

  const computedType = file.type && file.type !== "other" ? file.type : detectFileType(file.name, file.mimeType);

  // Never save Base64 or actual file contents in Firestore.
  const fileDocData = {
    name: file.name,
    type: computedType,
    size: Number(file.size) || 0,
    mimeType: file.mimeType || "application/octet-stream",

    b2FileId: file.b2FileId || null,
    b2FileName: b2FileName,

    b2BucketName: file.b2BucketName || "",
    folderId: file.folderId || null,
    isFolder: false,

    uploadedAt: file.uploadedAt || now,

    // Only save a real thumbnail URL, never Base64 image data.
    // Firestore metadata must contain a real URL, never a large Base64 image/video thumbnail.
    thumbnailUrl: file.thumbnailUrl?.startsWith("data:") ? null : file.thumbnailUrl || null,

    userId: userId,
    userEmail: userEmail,

    url: file.url || `/api/files/${fileId}`,

    isFavorite: Boolean(file.isFavorite),
    isDeleted: Boolean(file.isDeleted),
    ...(file.deletedAt ? { deletedAt: file.deletedAt } : {}),

    updatedAt: now,

    storedInB2: Boolean(file.storedInB2),
  };

  try {
    // 1. Save user file metadata
    const userFileRef = doc(db, "users", userId, "files", fileId);

    await setDoc(userFileRef, fileDocData);

    // 2. Maintain root files index
    const rootFileRef = doc(db, "files", fileId);

    await setDoc(rootFileRef, fileDocData);

    // 3. Update user storage statistics
    await syncUserStorageStats(userId);

    return {
      ...file,
      ...fileDocData,
    } as CloudFile;

  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function saveUserFolderToFirestore(
  userId: string,
  userEmail: string,
  folder: CloudFile
): Promise<CloudFile> {
  const now = new Date().toISOString();
  const folderData = {
    id: folder.id,
    name: folder.name,
    parentFolderId: folder.folderId || null,
    size: 0,
    userId,
    userEmail,
    uploadedAt: folder.uploadedAt || now,
    updatedAt: now,
  };
  const userFolderRef = doc(db, "users", userId, "folders", folder.id);
  try {
    await setDoc(userFolderRef, folderData);
    const savedFolder = await getDoc(userFolderRef);
    if (!savedFolder.exists()) throw new Error("Folder save was not confirmed in Firestore.");
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `users/${userId}/folders/${folder.id}`);
  }
  return { ...folder, ...folderData, isFolder: true, type: "other", mimeType: "application/x-directory" };
}

// Get user files ordered by uploadedAt descending
export async function getUserFilesFromFirestore(
  userId: string,
  category: FileCategory = "home",
  searchQuery: string = "",
  maxBytes: number = 100 * 1024 * 1024
): Promise<{ files: CloudFile[]; stats: StorageStats; expiredTrash: CloudFile[] }> {
  const path = `users/${userId}/files`;

  try {
    const filesColl = collection(db, "users", userId, "files");
    const q = query(filesColl, orderBy("uploadedAt", "desc"));
    const snap = await getDocs(q);

    const allFiles: CloudFile[] = [];

    snap.forEach((docSnap) => {
      const data = docSnap.data();
      // Legacy folders were stored beside file metadata. Continue recognizing
      // them until the user migrates or removes those old records.
      if (data.isFolder) {
        allFiles.push({
          id: docSnap.id,
          name: data.name || "Untitled folder",
          size: Number(data.size) || 0,
          type: "other",
          mimeType: "application/x-directory",
          folderId: data.folderId || null,
          isFolder: true,
          isDeleted: Boolean(data.isDeleted),
          deletedAt: data.deletedAt || null,
          uploadedAt: data.uploadedAt || new Date().toISOString(),
          updatedAt: data.updatedAt || new Date().toISOString(),
          isFavorite: false,
          userId: data.userId || userId,
          userEmail: data.userEmail,
        });
        return;
      }
      const name = data.name || "Untitled";
      const mimeType = data.mimeType || "application/octet-stream";
      const detected = detectFileType(name, mimeType);
      const computedType = data.type && data.type !== "other" ? data.type : detected;

      allFiles.push({
        id: docSnap.id,
        name: name,
        type: computedType,
        size: Number(data.size) || 0,
        mimeType: mimeType,
        b2FileId: data.b2FileId || undefined,
        b2FileName: data.b2FileName || undefined,
        folderId: data.parentFolderId ?? data.folderId ?? null,
        isFolder: Boolean(data.isFolder),
        uploadedAt: data.uploadedAt || new Date().toISOString(),
        updatedAt: data.updatedAt || new Date().toISOString(),
        thumbnailUrl: data.thumbnailUrl || null,
        userId: data.userId || userId,
        userEmail: data.userEmail,
        url: data.url || `/api/files/${docSnap.id}`,
        isFavorite: Boolean(data.isFavorite),
        isDeleted: Boolean(data.isDeleted),
        deletedAt: data.deletedAt || (data.isDeleted ? data.updatedAt : null),
      });
    });

    const foldersSnap = await getDocs(collection(db, "users", userId, "folders"));
    foldersSnap.forEach((folderSnap) => {
      const data = folderSnap.data();
      allFiles.push({
        id: folderSnap.id,
        name: data.name || "Untitled folder",
        size: Number(data.size) || 0,
        type: "other",
        mimeType: "application/x-directory",
        folderId: data.parentFolderId ?? data.folderId ?? null,
        isFolder: true,
        isDeleted: Boolean(data.isDeleted) || String(data.parentFolderId ?? data.folderId ?? "").startsWith("__trash__:"),
        deletedAt: data.deletedAt || null,
        uploadedAt: data.uploadedAt || new Date().toISOString(),
        updatedAt: data.updatedAt || new Date().toISOString(),
        isFavorite: false,
        userId: data.userId || userId,
        userEmail: data.userEmail,
      });
    });

    const folders = allFiles.filter((entry) => entry.isFolder);
    const fileRecords = allFiles.filter((entry) => !entry.isFolder);
    const folderSizes = new Map<string, number>();
    for (const folder of folders) folderSizes.set(folder.id, 0);
    for (const file of fileRecords) {
      if (!file.folderId) continue;
      let parentId: string | null | undefined = file.folderId;
      const visited = new Set<string>();
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        if (!folderSizes.has(parentId)) break;
        folderSizes.set(parentId, (folderSizes.get(parentId) || 0) + file.size);
        parentId = folders.find((entry) => entry.id === parentId)?.folderId;
      }
    }
    for (const folder of folders) folder.size = folderSizes.get(folder.id) || 0;

    const activeFiles = allFiles.filter((f) => !f.isDeleted && !f.isFolder);

    const storageUsed = fileRecords.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    let favoriteCount = 0;

    const categoryBreakdown: Record<
      FileType,
      { count: number; bytes: number }
    > = {
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

      const fType = file.type && categoryBreakdown[file.type] ? file.type : "other";
      categoryBreakdown[fType].count++;
      categoryBreakdown[fType].bytes += file.size;
    }

    const stats: StorageStats = {
      usedBytes: storageUsed,
      maxBytes: maxBytes,
      totalFiles: activeFiles.length,
      categoryBreakdown,
      favoriteCount,
    };

    let filtered = category === "trash"
      ? allFiles.filter((f) => f.isDeleted)
      : allFiles.filter((f) => !f.isDeleted);

    if (category === "folders") {
      filtered = filtered.filter((f) => f.isFolder);
    } else if (category === "apps") {
      filtered = filtered.filter((f) => !f.isFolder && /\.(exe|msi|app|dmg|pkg|deb|rpm|apk|aab|ipa|bat|cmd|appx|msix)$/i.test(f.name));
    } else if (category === "photos") {
      filtered = filtered.filter((f) => f.type === "image" || detectFileType(f.name, f.mimeType) === "image");
    } else if (category === "videos") {
      filtered = filtered.filter((f) => f.type === "video" || detectFileType(f.name, f.mimeType) === "video");
    } else if (category === "documents") {
      filtered = filtered.filter(
        (f) =>
          f.type === "document" ||
          f.type === "code" ||
          detectFileType(f.name, f.mimeType) === "document" ||
          detectFileType(f.name, f.mimeType) === "code"
      );
    } else if (category === "audio") {
      filtered = filtered.filter((f) => f.type === "audio" || detectFileType(f.name, f.mimeType) === "audio");
    } else if (category === "archives") {
      filtered = filtered.filter((f) => f.type === "archive" || detectFileType(f.name, f.mimeType) === "archive");
    } else if (category === "favorites") {
      filtered = filtered.filter((f) => f.isFavorite);
    }

    if (category !== "folders" && category !== "trash") {
      filtered = filtered.filter((f) => !f.isFolder);
    }

    if (searchQuery.trim()) {
      const qLower = searchQuery.toLowerCase();

      filtered = filtered.filter((f) =>
        f.name.toLowerCase().includes(qLower)
      );
    }

    const trashRetentionMs = 30 * 24 * 60 * 60 * 1000;
    const expiredTrash = allFiles.filter((file) =>
      !file.isFolder && file.isDeleted && file.deletedAt &&
      Date.now() - new Date(file.deletedAt).getTime() >= trashRetentionMs
    );

    return { files: filtered, stats, expiredTrash };

  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

// Get a single file document
export async function getUserFileFromFirestore(
  userId: string,
  fileId: string
): Promise<CloudFile | null> {
  const path = `users/${userId}/files/${fileId}`;
  try {
    const userFileRef = doc(db, "users", userId, "files", fileId);
    const snap = await getDoc(userFileRef);
    if (!snap.exists()) return null;
    return snap.data() as CloudFile;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

// Delete file permanently from Firestore
export async function deleteUserFileInFirestore(
  userId: string,
  fileId: string,
  permanent: boolean = true
): Promise<void> {
  const path = `users/${userId}/files/${fileId}`;

  try {
    const userFileRef = doc(db, "users", userId, "files", fileId);
    const rootFileRef = doc(db, "files", fileId);

    if (permanent) {
      await Promise.all([deleteDoc(userFileRef), deleteDoc(rootFileRef)]);
    } else {
      const deletedAt = new Date().toISOString();
      // Reuse updatedAt as the Trash timestamp. This stays compatible with
      // already-published rules that allow isDeleted and updatedAt updates.
      const updateData = { isDeleted: true, updatedAt: deletedAt };
      await updateDoc(userFileRef, updateData);
      await updateDoc(rootFileRef, updateData).catch(() => {});
    }

    await syncUserStorageStats(userId);

  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function deleteUserFolderInFirestore(
  userId: string,
  folderId: string,
  parentFolderId: string | null
): Promise<{ trashedFiles: number; deletedFolders: number }> {
  const path = `users/${userId}/folders/${folderId}`;
  try {
    const [filesSnapshot, foldersSnapshot] = await Promise.all([
      getDocs(collection(db, "users", userId, "files")),
      getDocs(collection(db, "users", userId, "folders")),
    ]);
    // Include old folder records that may still live in users/{uid}/files.
    const legacyFolders = filesSnapshot.docs.filter((entry) => entry.data().isFolder);
    const folderRecords = [
      ...foldersSnapshot.docs.map((entry) => ({ id: entry.id, data: entry.data(), legacy: false })),
      ...legacyFolders.map((entry) => ({ id: entry.id, data: entry.data(), legacy: true })),
    ];
    const descendants = new Set<string>([folderId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const entry of folderRecords) {
        const parent = entry.data.parentFolderId ?? entry.data.folderId ?? null;
        if (parent && descendants.has(parent) && !descendants.has(entry.id)) {
          descendants.add(entry.id);
          expanded = true;
        }
      }
    }
    const childFiles = filesSnapshot.docs.filter((entry) => descendants.has(entry.data().folderId));
    const childFolders = folderRecords.filter((entry) => descendants.has(entry.id));
    const now = new Date().toISOString();

    await Promise.all([
      ...childFiles.map(async (entry) => {
        const updateData = { isDeleted: true, deletedAt: now, updatedAt: now };
        await updateDoc(doc(db, "users", userId, "files", entry.id), updateData);
        await updateDoc(doc(db, "files", entry.id), updateData).catch(() => {});
      }),
      ...childFolders.map(async (entry) => {
        if (entry.legacy) {
          await updateDoc(doc(db, "users", userId, "files", entry.id), { isDeleted: true, updatedAt: now });
        } else {
          await updateDoc(doc(db, "users", userId, "folders", entry.id), { isDeleted: true, deletedAt: now, updatedAt: now });
        }
      }),
    ]);
    await syncUserStorageStats(userId);
    return { trashedFiles: childFiles.length, deletedFolders: childFolders.length };
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function restoreUserFolderInFirestore(userId: string, folderId: string): Promise<void> {
  const path = `users/${userId}/folders/${folderId}`;
  try {
    const [filesSnapshot, foldersSnapshot] = await Promise.all([
      getDocs(collection(db, "users", userId, "files")),
      getDocs(collection(db, "users", userId, "folders")),
    ]);
    const descendants = new Set<string>([folderId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const entry of foldersSnapshot.docs) {
        const parent = entry.data().parentFolderId ?? entry.data().folderId ?? null;
        if (parent && descendants.has(parent) && !descendants.has(entry.id)) {
          descendants.add(entry.id);
          expanded = true;
        }
      }
    }
    const now = new Date().toISOString();
    await Promise.all([
      ...foldersSnapshot.docs.filter((entry) => descendants.has(entry.id) && entry.data().isDeleted).map((entry) => {
        return updateDoc(doc(db, "users", userId, "folders", entry.id), { isDeleted: false, updatedAt: now });
      }),
      ...filesSnapshot.docs.filter((entry) => descendants.has(entry.id) && entry.data().isFolder && entry.data().isDeleted).map((entry) =>
        updateDoc(doc(db, "users", userId, "files", entry.id), { isDeleted: false, updatedAt: now })
      ),
      ...filesSnapshot.docs.filter((entry) => descendants.has(entry.data().folderId) && entry.data().isDeleted).map(async (entry) => {
        const updateData = { isDeleted: false, updatedAt: now };
        await updateDoc(doc(db, "users", userId, "files", entry.id), updateData);
        await updateDoc(doc(db, "files", entry.id), updateData).catch(() => {});
      }),
    ]);
    await syncUserStorageStats(userId);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function renameUserFolderInFirestore(userId: string, folderId: string, name: string): Promise<void> {
  const path = `users/${userId}/folders/${folderId}`;
  try {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 120) throw new Error("Folder name must be 1 to 120 characters.");
    await updateDoc(doc(db, "users", userId, "folders", folderId), { name: cleanName, updatedAt: new Date().toISOString() });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// Restore file from trash in Firestore
export async function restoreUserFileInFirestore(
  userId: string,
  fileId: string
): Promise<void> {
  const path = `users/${userId}/files/${fileId}`;

  try {
    const userFileRef = doc(db, "users", userId, "files", fileId);
    const rootFileRef = doc(db, "files", fileId);

    const updateData = {
      isDeleted: false,
      updatedAt: new Date().toISOString(),
    };

    await updateDoc(userFileRef, updateData);
    await updateDoc(rootFileRef, updateData).catch(() => {});

    await syncUserStorageStats(userId);

  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// Rename file in Firestore
export async function renameUserFileInFirestore(
  userId: string,
  fileId: string,
  newName: string
): Promise<void> {
  const path = `users/${userId}/files/${fileId}`;

  try {
    const userFileRef = doc(db, "users", userId, "files", fileId);
    const rootFileRef = doc(db, "files", fileId);

    const updateData = {
      name: newName.trim(),
      updatedAt: new Date().toISOString(),
    };

    await updateDoc(userFileRef, updateData);
    await updateDoc(rootFileRef, updateData).catch(() => {});

  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// Toggle favorite in Firestore
export async function toggleUserFileFavoriteInFirestore(
  userId: string,
  fileId: string,
  isFavorite: boolean
): Promise<void> {
  const path = `users/${userId}/files/${fileId}`;

  try {
    const userFileRef = doc(db, "users", userId, "files", fileId);
    const rootFileRef = doc(db, "files", fileId);

    const updateData = {
      isFavorite: isFavorite,
      updatedAt: new Date().toISOString(),
    };

    await updateDoc(userFileRef, updateData);
    await updateDoc(rootFileRef, updateData).catch(() => {});

  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}
