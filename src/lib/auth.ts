export interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  role: string;
  plan: string;
  planId: '100mb' | '50gb' | '250gb' | '1tb';
  maxStorageBytes: number;
  createdAt: string;
  isFirebaseUser?: boolean;
  emailVerified?: boolean;
  storageUsed?: number;
  fileCount?: number;
}

export const DEMO_USERS: User[] = [];

const AUTH_STORAGE_KEY = "cloudvalt_active_user";

export function getStoredUser(): User | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Backward compatibility check for old 2gb plan
    if (parsed.plan?.includes("2 GB") || !parsed.maxStorageBytes || parsed.maxStorageBytes === 50 * 1024 * 1024 * 1024) {
      parsed.plan = "100 MB Free (Test Mode)";
      parsed.planId = "100mb";
      parsed.maxStorageBytes = 100 * 1024 * 1024;
      setStoredUser(parsed);
    }
    return parsed;
  } catch (e) {
    console.error("Failed to read user from storage:", e);
    return null;
  }
}

export function setStoredUser(user: User | null): void {
  if (typeof window === "undefined") return;
  try {
    if (user) {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
    // Dispatch custom event so all listeners update immediately
    window.dispatchEvent(new Event("cloudvalt_auth_change"));
  } catch (e) {
    console.error("Failed to update user in storage:", e);
  }
}
