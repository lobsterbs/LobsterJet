/* Zeolite extension subsystem: runtime API surface.

   The centralized registry. buildApi() produces the browser.* object a
   given extension context sees, plus the chrome.* alias (Firefox
   exposes compatible chrome.* names for the same underlying APIs).
   Not-yet-implemented namespaces are intentionally ABSENT so feature
   detection like "if (browser.tabs)" answers honestly instead of
   throwing or, worse, lying. Events that need the background runtime
   (onInstalled/onStartup) register listeners but do not fire until
   that phase lands. */

import type { ExtensionRecord } from "./types";
import { extensionUrl } from "./origin";
import { TABS, tabView, changeView } from "./tabs";
import type { TabsEvent } from "./tabs";
import type { MenuClickListener } from "./contextmenus";
import { SCRIPTING } from "./scripting";
import { MENUS } from "./contextmenus";
import { DOWNLOADS } from "./downloads";
import { hostPatternsMatch } from "./permissions";
import type { ExtensionStorageArea, StorageValue } from "./storage";
import type { ExtensionMessenger, MessageListener, ConnectListener, MessageSender } from "./messaging";

export interface EventNamespace<L> {
  addListener(l: L): void;
  removeListener(l: L): void;
  hasListener(l: L): boolean;
}

export function makeEvent<L>(): EventNamespace<L> & { _listeners: Set<L> } {
  const listeners = new Set<L>();
  return {
    addListener: (l: L) => listeners.add(l),
    removeListener: (l: L) => listeners.delete(l),
    hasListener: (l: L) => listeners.has(l),
    _listeners: listeners,
  };
}

export interface ApiDeps {
  messenger: ExtensionMessenger;
  storage: { local: ExtensionStorageArea; sync: ExtensionStorageArea; session: ExtensionStorageArea };
}

function wrapArea(area: ExtensionStorageArea): Record<string, unknown> {
  return {
    get: (keys?: string | string[] | Record<string, StorageValue> | null) => area.get(keys),
    set: (items: Record<string, unknown>) => area.set(items),
    remove: (keys: string | string[]) => area.remove(keys),
    clear: () => area.clear(),
    getBytesInUse: (keys?: string | string[]) => area.getBytesInUse(keys),
  };
}

/* ---- tabs / windows event plumbing -------------------------------- */

/** Args one extension's tab listener gets for a registry event, with
    url/title fields permission-gated per Firefox semantics. */
function tabsEventArgs(
  ext: ExtensionRecord,
  kind: "created" | "updated" | "activated" | "removed",
  ev: TabsEvent
): unknown[] | null {
  switch (ev.type) {
    case "created":
      return kind === "created" ? [tabView(ext, ev.tab)] : null;
    case "updated":
      return kind === "updated" ? [ev.tabId, changeView(ext, ev.change), tabView(ext, ev.tab)] : null;
    case "activated":
      return kind === "activated" ? [{ tabId: ev.tabId, windowId: ev.windowId }] : null;
    case "removed":
      return kind === "removed" ? [ev.tabId, { windowId: ev.windowId, isWindowClosing: false }] : null;
  }
}

function makeTabsEvent(
  ext: ExtensionRecord,
  kind: "created" | "updated" | "activated" | "removed"
): EventNamespace<(...args: unknown[]) => void> {
  const offs = new Map<unknown, () => void>();
  return {
    addListener: (l) => {
      if (offs.has(l)) return;
      offs.set(l, TABS.subscribe((ev) => {
        const args = tabsEventArgs(ext, kind, ev);
        if (!args) return;
        try {
          l(...args);
        } catch {
          /* a broken listener is the extension's own problem */
        }
      }));
    },
    removeListener: (l) => {
      offs.get(l)?.();
      offs.delete(l);
    },
    hasListener: (l) => offs.has(l),
  };
}

export function buildApi(
  ext: ExtensionRecord,
  sender: MessageSender,
  deps: ApiDeps
): { browser: Record<string, unknown>; chrome: Record<string, unknown> } {
  /* Bridge the messaging event namespaces into the messenger so
     listeners registered by any context of this extension are
     reachable from every other context. */
  const offs = new Map<unknown, () => void>();
  function bridged<L>(reg: (l: L) => () => void): EventNamespace<L> {
    return {
      addListener: (l: L) => {
        if (offs.has(l)) return;
        offs.set(l, reg(l));
      },
      removeListener: (l: L) => {
        offs.get(l)?.();
        offs.delete(l);
      },
      hasListener: (l: L) => offs.has(l),
    };
  }
  const runtime = {
    id: ext.id,
    getManifest: (): Record<string, unknown> =>
      JSON.parse(JSON.stringify(ext.manifest)) as Record<string, unknown>,
    getURL: (path: string): string => extensionUrl(ext.id, path),
    sendMessage: (msg: unknown): Promise<unknown> =>
      deps.messenger.sendMessage(ext.id, sender, msg),
    onMessage: bridged<MessageListener>((l) => deps.messenger.onMessage(ext.id, l)),
    connect: (name: string) => deps.messenger.connect(ext.id, name, sender),
    onConnect: bridged<ConnectListener>((l) => deps.messenger.onConnect(ext.id, l)),
    get lastError(): null {
      return null;
    },
    /* Register-only until the background runtime phase fires them. */
    onInstalled: makeEvent<(details: unknown) => void>(),
    onStartup: makeEvent<() => void>(),
  };
  const storageNs = {
    local: wrapArea(deps.storage.local),
    sync: wrapArea(deps.storage.sync),
    session: wrapArea(deps.storage.session),
  };
  /* tabs: the engine-side mirror of the UI tab model (see ./tabs).
     The tabs permission (or a matching host permission) gates url and
     title visibility exactly as Firefox does; getCurrent has no tab
     context here and rejects honestly. */
  const tabsNs = {
    get: (id: number) => {
      const t = TABS.get(id);
      return t ? Promise.resolve(tabView(ext, t)) : Promise.reject(new Error("Invalid tab ID: " + id));
    },
    getCurrent: () =>
      Promise.reject(new Error("zeolite: tabs.getCurrent may only be called from a tab context")),
    query: (q: Record<string, unknown> = {}) => {
      if (!ext.permissions.includes("tabs") && (q.url !== undefined || q.title !== undefined)) {
        return Promise.reject(
          new Error("zeolite: tabs.query url/title matching requires the 'tabs' permission"),
        );
      }
      return Promise.resolve(TABS.query(q).map((t) => tabView(ext, t)));
    },
    create: (props: Record<string, unknown> = {}) =>
      TABS.create(props as { url?: string; active?: boolean; index?: number }),
    update: (id: number | undefined, props: Record<string, unknown> = {}) =>
      TABS.update(id ?? null, props as { active?: boolean; url?: string }),
    remove: (ids: number | number[]) => TABS.remove(Array.isArray(ids) ? ids : [ids]),
    onCreated: makeTabsEvent(ext, "created"),
    onUpdated: makeTabsEvent(ext, "updated"),
    onActivated: makeTabsEvent(ext, "activated"),
    onRemoved: makeTabsEvent(ext, "removed"),
  };
  /* windows: this engine is a single window; focus never changes. */
  const win = (populate: boolean) => ({
    id: 1,
    focused: true,
    incognito: false,
    alwaysOnTop: false,
    state: "normal",
    ...(populate ? { tabs: TABS.list().map((t) => tabView(ext, t)) } : {}),
  });
  const windowsNs = {
    WINDOW_ID_CURRENT: -1,
    WINDOW_ID_NONE: -1,
    get: (id: number, opts?: { populate?: boolean }) =>
      id === 1 || id === -1
        ? Promise.resolve(win(!!opts?.populate))
        : Promise.reject(new Error("Invalid window ID: " + id)),
    getCurrent: (opts?: { populate?: boolean }) => Promise.resolve(win(!!opts?.populate)),
    getLastFocused: (opts?: { populate?: boolean }) => Promise.resolve(win(!!opts?.populate)),
    getAll: (opts?: { populate?: boolean }) => Promise.resolve([win(!!opts?.populate)]),
    onFocusChanged: makeEvent<(windowId: number) => void>(),
  };
  /* webNavigation: derived from top-level tab URL changes; frameId is
     always 0 (no subframe signal) and onCompleted fires together with
     onCommitted (no per-load completion signal). Firefox permission
     semantics: webNavigation permission or matching host permission. */
  function navEvent(): EventNamespace<(details: Record<string, unknown>) => void> {
    const offs = new Map<unknown, () => void>();
    return {
      addListener: (l) => {
        if (offs.has(l)) return;
        offs.set(l, TABS.subscribe((ev) => {
          if (ev.type !== "updated" || ev.change.url === undefined) return;
          if (!ext.permissions.includes("webNavigation") &&
              !hostPatternsMatch(ext.hostPermissions, ev.change.url)) return;
          try {
            l({ tabId: ev.tabId, frameId: 0, url: ev.change.url, transitionType: "link", timeStamp: Date.now() });
          } catch {
            /* a broken listener is the extension's own problem */
          }
        }));
      },
      removeListener: (l) => {
        offs.get(l)?.();
        offs.delete(l);
      },
      hasListener: (l) => offs.has(l),
    };
  }
  const browser: Record<string, unknown> = { runtime, storage: storageNs, tabs: tabsNs, windows: windowsNs };
  /* Privileged namespaces appear only with their permission, so
     feature detection stays honest. */
  if (ext.permissions.includes("scripting")) {
    browser.scripting = {
      executeScript: (i: { target: { tabId: number }; files: string[] }) =>
        SCRIPTING.executeScript(ext, i.target.tabId, i.files),
      insertCSS: (i: { target: { tabId: number }; files: string[] }) =>
        SCRIPTING.insertCSS(ext, i.target.tabId, i.files),
    };
  }
  if (ext.permissions.includes("webNavigation")) {
    const nav = navEvent();
    browser.webNavigation = { onCommitted: nav, onCompleted: nav };
  }
  if (ext.permissions.includes("contextMenus") || ext.permissions.includes("menus")) {
    const menusNs = {
      create: (props: Record<string, unknown> | string, ...rest: unknown[]) =>
        typeof props === "string"
          ? MENUS.create(ext, { id: props, title: rest[0] as string | undefined })
          : MENUS.create(ext, props as Record<string, never>),
      update: (id: string, props: Record<string, unknown>) => MENUS.update(ext, id, props),
      remove: (id: string) => MENUS.remove(ext, id),
      removeAll: () => MENUS.removeAll(ext),
      onClicked: bridged<MenuClickListener>((l) => MENUS.onClicked(ext.id, l)),
    };
    browser.contextMenus = menusNs;
    browser.menus = menusNs;
  }
  if (ext.permissions.includes("downloads")) {
    browser.downloads = {
      download: (o: { url: string; filename?: string }) => DOWNLOADS.download(ext, o),
      search: (q: Record<string, unknown> = {}) => Promise.resolve(DOWNLOADS.search(q)),
    };
  }
  /* Firefox-style chrome.* alias over the same implementations. */
  return { browser, chrome: browser };
}
