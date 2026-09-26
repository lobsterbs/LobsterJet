/* Zeolite extension subsystem: webNavigation bridge.

   The engine's fetch handler observes main-frame document loads
   (navigation-mode requests whose response is HTML) and reports them
   through WEBNAV. Tab identity is resolved from the UI tab registry
   by exact destination match; loads that belong to no known tab are
   not reported rather than reported with a fabricated tab id.
   Firefox permission semantics (the "webNavigation" permission gates
   event delivery) are enforced at the API layer in ./runtime. Only
   onCommitted is real; the rest of the navigation lifecycle is
   honestly absent (see ./compat). */

import { TABS } from "./tabs";

export interface NavigationCommitted {
  tabId: number;
  url: string;
  frameId: number;
  timeStamp: number;
}

export type NavigationListener = (info: NavigationCommitted) => void;

class NavigationRegistry {
  private readonly listeners = new Set<NavigationListener>();

  subscribe(l: NavigationListener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  /** Main-frame document load observed for url. Fires nothing when
      the destination belongs to no tab in the UI model. */
  committed(url: string): void {
    const tab = TABS.list().find((t) => t.url === url);
    if (!tab) return;
    const info: NavigationCommitted = {
      tabId: tab.id,
      url,
      frameId: 0,
      timeStamp: Date.now(),
    };
    for (const l of [...this.listeners]) {
      try {
        l(info);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
  }
}

export const WEBNAV = new NavigationRegistry();
