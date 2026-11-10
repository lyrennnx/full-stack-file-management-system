"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X, FileText, FileImage, FileSpreadsheet, FileArchive, File, Film, Music2, Folder, Check, AlertCircle, Loader2 } from "lucide-react";
import { type DriveItem, fileCategory } from "@/lib/types";

export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const firstInput = ref.current?.querySelector<HTMLElement>('input:not([type="hidden"]):not([hidden]), select, textarea');
    if (firstInput) firstInput.focus(); else ref.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const nodes = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, a[href], [tabindex="0"]');
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", handler);
    return () => { document.body.style.overflow = original; document.removeEventListener("keydown", handler); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? "modal-wide" : ""}`}><div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>{children}</div></div>;
}
export function FileIcon({ item, size = 20 }: { item: DriveItem; size?: number }) {
  const category = fileCategory(item);
  const Icon = item.kind === "folder" ? Folder : category === "Images" ? FileImage : category === "PDFs" ? FileText : category === "Videos" ? Film : category === "Audio" ? Music2 : category === "Archives" ? FileArchive : ["csv", "xlsx", "xls"].includes(item.extension) ? FileSpreadsheet : category === "Documents" ? FileText : File;
  return <span className={`file-type-icon ${item.kind === "folder" ? "type-folder" : "type-" + category.toLowerCase()}`}><Icon size={size} strokeWidth={1.7} /></span>;
}
export function FileVisual({ item, compact = false }: { item: DriveItem; compact?: boolean }) {
  if (item.mimeType.startsWith("image/") && item.extension !== "svg") return <div className="file-visual photo"><img src={`/api/files/${item.id}/content`} alt={item.name} loading="lazy" /><span className="visual-extension">{item.extension.toUpperCase()}</span></div>;
  if (item.extension === "pdf") return <div className="file-visual pdf-visual"><div className="mini-document"><div className="document-logo"><span>f.</span> FILEBOX STUDIO</div><div className="document-rule"/><h3>Good design.<br/>Great possibilities.</h3><p>Brand guidelines & visual identity</p><div className="document-footer">THE BRAND BOOK <span>2026 — 01</span></div></div><span className="visual-extension">PDF</span></div>;
  if (["csv", "xlsx"].includes(item.extension)) return <div className="file-visual sheet-visual"><div className="mini-sheet"><div className="sheet-top">PROJECT OVERVIEW <span>Q3 / 2026</span></div><div className="sheet-grid">{Array.from({length: compact ? 24 : 36}, (_, i) => <span key={i} className={i < 6 ? "sheet-cell-head" : ""}>{i < 6 ? ["PROJECT", "STATUS", "OWNER", "BUDGET", "DUE", "NOTES"][i] : i % 6 === 1 ? "In progress" : i % 6 === 0 ? "Project " + Math.ceil(i / 6) : i % 6 === 3 ? "$2,400" : "—"}</span>)}</div></div><span className="visual-extension">{item.extension.toUpperCase()}</span></div>;
  return <div className={`file-visual generic-visual ${fileCategory(item).toLowerCase()}`}><FileIcon item={item} size={48} /><span>{item.extension.toUpperCase() || "FILE"}</span></div>;
}
export function Toast({ message, error, onClose }: { message: string; error?: boolean; onClose: () => void }) {
  useEffect(() => { const timer = setTimeout(onClose, 5000); return () => clearTimeout(timer); }, [message, onClose]);
  return <div className={`toast ${error ? "toast-error" : ""}`} role="status">{error ? <AlertCircle size={19} /> : <span className="toast-check"><Check size={14} /></span>}<span>{message}</span><button onClick={onClose} aria-label="Dismiss notification"><X size={16}/></button></div>;
}
export function Spinner({ size = 18 }: { size?: number }) { return <Loader2 size={size} className="spinner" />; }
export function Brand({ collapsed = false }: { collapsed?: boolean }) { return <span className="brand"><span className="brand-symbol"><svg width="33" height="35" viewBox="0 0 33 35" fill="none" aria-hidden="true"><path d="M3 9.5 16.5 2 30 9.5v16L16.5 33 3 25.5v-16Z" fill="currentColor"/><path d="m3 9.5 13.5 7.7L30 9.5M16.5 17v16M9.5 6l14 7.5v8l-7 4" stroke="white" strokeWidth="2.2" strokeLinejoin="round"/></svg></span>{!collapsed && <span>filebox<span className="brand-period">.</span></span>}</span>; }
