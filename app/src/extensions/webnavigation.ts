/* Zeolite extension subsystem: webNavigation events.

   Derived from the proxy fetch path: the SW fires committed when a
   top-level document response is handed to the browser, completed
   when its rewritten stream finishes, and error when the upstream
   fetch fails. tabId resolution goes through the tabs bridge (exact
   destination URL match; -1 when the UI has not synced a matching
   tab). Only top-level documents produce events; the engine cannot
   observe subframe or history navigations, and the compat matrix
   says exactly that. */

export interface NavDetails {
  tabId: number;
  url: string;
  frameId: number;
  err?: string;
}

export type NavKind = "committed" | "completed" | "error";
export type NavListener = (details: NavDetails) => void;

export class WebNav {
  private readonly listeners = new Map<NavKind, Set<NavListener>>();

  subscribe(kind: NavKind, l: NavListener): () => void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    set.add(l);
    return () => set?.delete(l);
  }

  fire(kind: NavKind, details: NavDetails): void {
    const set = this.listeners.get(kind);
    if (!set) return;
    for (const l of [...set]) {
      try {
        l(details);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
  }
}

export const WEBNAV = new WebNav();
