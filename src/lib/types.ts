export type View = "all" | "recent" | "shared" | "starred" | "trash";
export type DriveItem = {
  id: string; name: string; kind: "file" | "folder"; size: number;
  mimeType: string; extension: string; isStarred: boolean; isShared: boolean;
  createdAt: string; updatedAt: string; folderId: string | null;
  color?: string; count?: number; deletedAt?: string | null; permission?: "viewer" | "editor";
};
export type Account = { id: string; email: string; fullName: string; isGuest: boolean };
export type Activity = { id: string; action: string; name: string; createdAt: string };
export type DriveData = {
  user: Account;
  hasMore?: boolean;
  items: DriveItem[]; folders: DriveItem[]; quickAccess: DriveItem[];
  breadcrumbs: { id: string; name: string }[];
  stats: { totalFiles: number; totalFolders: number; used: number; total: number; shared: number };
  activity: Activity[];
  backend: { storage: "local" | "supabase"; auth: "local" | "supabase" };
};
export type ShareInfo = { id: string; permission: string; expiresAt: string | null; createdAt: string; passwordProtected: boolean; recipientEmail?: string | null };
export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes) return "0 B";
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${parseFloat((bytes / 1024 ** i).toFixed(decimals))} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}
export function fileCategory(item: Pick<DriveItem, "mimeType" | "extension">) {
  if (item.mimeType.startsWith("image/")) return "Images";
  if (item.mimeType === "application/pdf") return "PDFs";
  if (item.mimeType.startsWith("video/")) return "Videos";
  if (item.mimeType.startsWith("audio/")) return "Audio";
  if (["zip", "rar", "7z", "gz", "tar"].includes(item.extension)) return "Archives";
  if (item.mimeType.startsWith("text/") || ["doc", "docx", "xlsx", "xls", "pptx", "json"].includes(item.extension)) return "Documents";
  return "Other";
}
export function relativeDate(date: string) {
  const days = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
