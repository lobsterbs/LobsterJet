/* Zeolite extension subsystem: downloads.

   browser.downloads.download dispatches to the engine UI clients
   (which own real download UX) and resolves on their ack. search
   answers from the registry's own record. No pause/resume/cancel
   yet: those need a real download manager host. */

import type { ExtensionRecord } from "./types";

export interface DownloadOp {
  nonce: string;
  id: number;
  url: string;
  filename: string | null;
}

export interface DownloadItem {
  id: number;
  url: string;
  filename: string | null;
  state: "in_progress" | "complete" | "interrupted";
  startTime: number;
}

export class DownloadsRegistry {
  private readonly items = new Map<number, DownloadItem>();
  private readonly pending = new Map<string, { resolve: (id: number) => void; reject: (e: Error) => void }>();
  private dispatch: ((op: DownloadOp) => void) | null = null;
  private seq = 0;

  setDispatch(fn: ((op: DownloadOp) => void) | null): void {
    this.dispatch = fn;
  }

  ack(nonce: string, ok: boolean, error?: string): void {
    const p = this.pending.get(nonce);
    if (!p) return;
    this.pending.delete(nonce);
    const id = nonceNumber(nonce);
    if (ok) p.resolve(id);
    else p.reject(new Error(error ?? "zeolite: download failed"));
  }

  download(ext: ExtensionRecord, options: { url: string; filename?: string }): Promise<number> {
    if (!ext.permissions.includes("downloads")) {
      return Promise.reject(new Error("zeolite: permission 'downloads' not granted to this extension"));
    }
    if (!this.dispatch) return Promise.reject(new Error("zeolite: no download host attached to this engine"));
    const id = ++this.seq;
    const nonce = "zl-dl-" + id;
    const p = new Promise<number>((resolve, reject) => this.pending.set(nonce, { resolve, reject }));
    this.items.set(id, { id, url: options.url, filename: options.filename ?? null, state: "in_progress", startTime: Date.now() });
    this.dispatch({ nonce, id, url: options.url, filename: options.filename ?? null });
    return p;
  }

  /** Mark a dispatched download finished (UI ack helper). */
  finish(id: number, state: "complete" | "interrupted"): void {
    const it = this.items.get(id);
    if (it) it.state = state;
  }

  search(q: Record<string, unknown>): DownloadItem[] {
    const out: DownloadItem[] = [];
    for (const it of this.items.values()) {
      if (q.id !== undefined && it.id !== q.id) continue;
      if (typeof q.url === "string" || Array.isArray(q.url)) {
        const pats = (Array.isArray(q.url) ? q.url : [q.url]).map(String);
        if (!pats.some((p) => new RegExp(p).test(it.url))) continue;
      }
      if (typeof q.filename === "string" || Array.isArray(q.filename)) {
        const pats = (Array.isArray(q.filename) ? q.filename : [q.filename]).map(String);
        const fn = it.filename ?? "";
        if (!pats.some((p) => new RegExp(p).test(fn))) continue;
      }
      if (q.state !== undefined && it.state !== q.state) continue;
      out.push({ ...it });
    }
    return out.sort((a, b) => a.id - b.id);
  }
}

function nonceNumber(nonce: string): number {
  const n = Number(nonce.replace(/^zl-dl-/, ""));
  return Number.isFinite(n) ? n : 0;
}

export const DOWNLOADS = new DownloadsRegistry();
