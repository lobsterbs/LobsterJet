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
  const browser: Record<string, unknown> = { runtime, storage: storageNs };
  /* Firefox-style chrome.* alias over the same implementations. */
  return { browser, chrome: browser };
}
