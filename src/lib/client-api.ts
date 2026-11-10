export async function api<T = Record<string, unknown>>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { ...(options?.body instanceof Blob || options?.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...options?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result as T;
}
export function driveAction(action: string, data: Record<string, unknown> = {}) { return api("/api/drive", { method: "POST", body: JSON.stringify({ action, ...data }) }); }
export function downloadFile(id: string, name: string, query = "") {
  const link = document.createElement("a");
  link.href = `/api/files/${id}/content?download=1${query}`;
  link.download = name; document.body.appendChild(link); link.click(); link.remove();
}
