/* Zeolite extension subsystem: browser.scripting.

   executeScript/insertCSS with declared files, dispatched to the
   engine UI clients which inject into the same-origin proxied
   frame and ack back through the SW. func-based injection cannot
   cross the SW boundary as a live closure and is honestly
   unsupported. Permission model follows Firefox: the "scripting"
   permission plus a host permission matching the target tab. */

import type { ExtensionRecord } from "./types";
import { TABS } from "./tabs";
import { hostPatternsMatch } from "./permissions";

export interface ScriptingOp {
  nonce: string;
  extId: string;
  tabId: number;
  files: string[];
  css: boolean;
}

export class ScriptingRegistry {
  private readonly pending = new Map<string, { resolve: (r: unknown[]) => void; reject: (e: Error) => void }>();
  private dispatch: ((op: ScriptingOp) => void) | null = null;
  private seq = 0;

  setDispatch(fn: ((op: ScriptingOp) => void) | null): void {
    this.dispatch = fn;
  }

  ack(nonce: string, ok: boolean, error?: string, results?: unknown[]): void {
    const p = this.pending.get(nonce);
    if (!p) return;
    this.pending.delete(nonce);
    if (ok) p.resolve(results ?? []);
    else p.reject(new Error(error ?? "zeolite: scripting op failed"));
  }

  private send(ext: ExtensionRecord, tabId: number, files: string[], css: boolean): Promise<unknown[]> {
    if (!this.dispatch) return Promise.reject(new Error("zeolite: no scripting host attached to this engine"));
    if (!ext.permissions.includes("scripting")) {
      return Promise.reject(new Error("zeolite: permission 'scripting' not granted to this extension"));
    }
    const tab = TABS.get(tabId);
    if (!tab) return Promise.reject(new Error("Invalid tab ID: " + tabId));
    if (!hostPatternsMatch(ext.hostPermissions, tab.url)) {
      return Promise.reject(new Error("zeolite: host permission for '" + tab.url + "' not granted to this extension"));
    }
    const nonce = "zl-scr-" + ++this.seq;
    const p = new Promise<unknown[]>((resolve, reject) => this.pending.set(nonce, { resolve, reject }));
    this.dispatch({ nonce, extId: ext.id, tabId, files, css });
    return p;
  }

  executeScript(ext: ExtensionRecord, tabId: number, files: string[]): Promise<unknown[]> {
    return this.send(ext, tabId, files, false);
  }

  insertCSS(ext: ExtensionRecord, tabId: number, files: string[]): Promise<void> {
    return this.send(ext, tabId, files, true).then(() => undefined);
  }
}

export const SCRIPTING = new ScriptingRegistry();
