"use client";
import { useRef, useState } from "react";
import { UploadCloud, File, X, CheckCircle2, RotateCcw, ShieldCheck } from "lucide-react";
import { Modal, Spinner } from "./ui";
import { api } from "@/lib/client-api";
import { formatBytes } from "@/lib/types";
type Entry = { key: string; file: File; progress: number; state: "ready" | "uploading" | "done" | "error" | "cancelled"; error?: string; uploadId?: string };
type Init = { id: string; storage: string; offset: number; endpoint?: string; token?: string; path?: string; bucket?: string };
export default function UploadModal({ folderId, initialFiles = [], onClose, onComplete, notify }: { folderId: string | null; initialFiles?: File[]; onClose: () => void; onComplete: () => void; notify: (text: string, error?: boolean) => void }) {
  const [entries, setEntries] = useState<Entry[]>(() => initialFiles.map(file => ({ key: crypto.randomUUID(), file, progress: 0, state: "ready" })));
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const stopped = useRef(false);
  const tusUploads = useRef(new Map<string, { abort: (terminate?: boolean) => Promise<void> }>());
  const update = (key: string, patch: Partial<Entry>) => setEntries(previous => previous.map(entry => entry.key === key ? { ...entry, ...patch } : entry));
  function add(files: FileList | File[]) {
    const incoming = Array.from(files).map(file => ({ key: crypto.randomUUID(), file, progress: 0, state: "ready" as const }));
    setEntries(previous => [...previous, ...incoming]);
  }
  async function cancel(entry: Entry) {
    controllers.current.get(entry.key)?.abort();
    await tusUploads.current.get(entry.key)?.abort(true).catch(() => undefined);
    if (entry.uploadId) await api(`/api/uploads?id=${entry.uploadId}`, { method: "DELETE" }).catch(() => undefined);
    update(entry.key, { state: "cancelled", error: "Upload cancelled" });
  }
  function close() {
    stopped.current = true;
    controllers.current.forEach(controller => controller.abort());
    tusUploads.current.forEach(upload => { void upload.abort(); });
    onClose();
  }
  async function uploadAll() {
    stopped.current = false;
    setBusy(true); let successes = 0;
    for (const entry of entries.filter(entry => ["ready", "error"].includes(entry.state))) {
      if (stopped.current) break;
      const controller = new AbortController(); controllers.current.set(entry.key, controller);
      const fingerprint = `filebox-upload:${entry.file.name}:${entry.file.size}:${entry.file.lastModified}:${folderId || "root"}`;
      try {
        update(entry.key, { state: "uploading", error: undefined });
        const pendingId = entry.uploadId || localStorage.getItem(fingerprint);
        const init = await api<Init>("/api/uploads", { method: "POST", body: JSON.stringify({ action: "init", name: entry.file.name, size: entry.file.size, mimeType: entry.file.type || "application/octet-stream", folderId, uploadId: pendingId }), signal: controller.signal });
        update(entry.key, { uploadId: init.id }); localStorage.setItem(fingerprint, init.id);
        if (init.storage === "supabase") {
          const { Upload } = await import("tus-js-client");
          await new Promise<void>((resolve, reject) => {
            const upload = new Upload(entry.file, {
              endpoint: init.endpoint!, headers: { "x-signature": init.token! },
              metadata: { bucketName: init.bucket!, objectName: init.path!, contentType: entry.file.type || "application/octet-stream", cacheControl: "3600" },
              chunkSize: 6 * 1024 * 1024, retryDelays: [0, 1000, 3000, 5000], uploadDataDuringCreation: true, removeFingerprintOnSuccess: true,
              onProgress: (loaded, total) => update(entry.key, { progress: Math.round(loaded / total * 99) }),
              onError: reject, onSuccess: () => resolve(),
            });
            tusUploads.current.set(entry.key, upload);
            controller.signal.addEventListener("abort", () => { void upload.abort(); reject(new DOMException("Cancelled", "AbortError")); }, { once: true });
            void upload.findPreviousUploads().then(previous => { if (previous.length) upload.resumeFromPreviousUpload(previous[0]); upload.start(); });
          });
        } else {
          const chunkSize = 5 * 1024 * 1024;
          for (let offset = init.offset; offset < entry.file.size; offset += chunkSize) {
            const chunk = entry.file.slice(offset, offset + chunkSize);
            await api(`/api/uploads?id=${init.id}`, { method: "PATCH", body: chunk, headers: { "Content-Type": "application/octet-stream", "X-Upload-Offset": String(offset) }, signal: controller.signal });
            update(entry.key, { progress: Math.min(99, Math.round((offset + chunk.size) / entry.file.size * 100)) });
          }
        }
        await api("/api/uploads", { method: "POST", body: JSON.stringify({ action: "complete", id: init.id }), signal: controller.signal });
        localStorage.removeItem(fingerprint); update(entry.key, { state: "done", progress: 100 }); successes++;
      } catch (error) {
        const cancelled = controller.signal.aborted;
        update(entry.key, { state: cancelled ? "cancelled" : "error", error: cancelled ? "Upload cancelled" : error instanceof Error ? error.message : "Upload failed" });
      } finally { controllers.current.delete(entry.key); tusUploads.current.delete(entry.key); }
    }
    setBusy(false);
    if (successes) { onComplete(); notify(`${successes} ${successes === 1 ? "file" : "files"} uploaded successfully`); }
  }
  const pending = entries.filter(entry => ["ready", "error"].includes(entry.state)).length;
  return <Modal title="Upload files" subtitle="A new home for your ideas. Add files to your workspace." onClose={close}>
    <div className={`dropzone ${dragging ? "dragging" : ""}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); e.stopPropagation(); setDragging(false); add(e.dataTransfer.files); }}>
      <div className="dropzone-icon"><UploadCloud size={25}/></div><h3>Drag & drop your files here</h3><p>or choose something from your device</p><button className="button-primary" onClick={() => input.current?.click()}>Browse files</button><input ref={input} type="file" multiple hidden onChange={e => { if (e.target.files) add(e.target.files); e.target.value = ""; }}/>
    </div><p className="upload-limit">All common file types supported · Up to 250 MB per file locally</p>
    {entries.length > 0 && <div className="upload-list">{entries.map(entry => <div className="upload-file" key={entry.key}><File size={22}/><div className="upload-file-info"><strong>{entry.file.name}</strong><p className={entry.error ? "upload-error" : ""}>{entry.error || formatBytes(entry.file.size)}</p>{["uploading", "done"].includes(entry.state) && <div className="upload-progress"><span style={{width:`${entry.progress}%`}}/></div>}</div>{entry.state === "done" ? <CheckCircle2 size={19} className="upload-success"/> : entry.state === "uploading" ? <><span className="upload-status">{entry.progress}%</span><button className="icon-button" aria-label="Cancel upload" onClick={() => void cancel(entry)}><X size={16}/></button></> : entry.state === "error" ? <button className="icon-button" aria-label="Retry upload" onClick={() => update(entry.key, { state: "ready", error: undefined })}><RotateCcw size={16}/></button> : <button className="icon-button" aria-label="Remove file" onClick={() => setEntries(previous => previous.filter(file => file.key !== entry.key))}><X size={16}/></button>}</div>)}</div>}
    <div className="share-security"><ShieldCheck size={13}/>Your files are private. Only you decide who gets access.</div><div className="modal-actions"><button className="button-secondary" onClick={close}>{busy ? "Cancel & close" : "Close"}</button><button className="button-primary" disabled={!pending || busy} onClick={() => void uploadAll()}>{busy ? <Spinner size={15}/> : <UploadCloud size={15}/>} {busy ? "Uploading…" : `Upload ${pending ? `all (${pending})` : "files"}`}</button></div>
  </Modal>;
}
