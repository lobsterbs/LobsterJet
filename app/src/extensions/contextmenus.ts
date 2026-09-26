/* Zeolite extension subsystem: contextMenus / menus.

   Registration registry. The engine UI surfaces the registered
   items in its context menu and reports clicks back through the
   zl:menuClick control message; the registry routes the click to
   the owning extension's onClicked listeners with the same
   permission-gated Tab view the tabs API produces. */

import { extensions } from "./manager";
import { TABS, tabView } from "./tabs";
import type { ExtensionId, ExtensionRecord } from "./types";

export interface MenuProps {
  id?: string;
  title?: string;
  contexts?: string[];
  parentId?: string;
  type?: string;
  enabled?: boolean;
}

export interface MenuItem {
  id: string;
  extId: ExtensionId;
  title: string;
  contexts: string[];
  parentId: string | null;
  type: string;
  enabled: boolean;
}

export type MenuClickListener = (info: Record<string, unknown>, tab: Record<string, unknown> | undefined) => void;

export class ContextMenusRegistry {
  private readonly items = new Map<ExtensionId, Map<string, MenuItem>>();
  private readonly listeners = new Map<ExtensionId, Set<MenuClickListener>>();
  private seq = 0;

  create(ext: ExtensionRecord, props: MenuProps): string {
    if (!ext.permissions.includes("contextMenus") && !ext.permissions.includes("menus")) {
      throw new Error("zeolite: contextMenus permission not granted to this extension");
    }
    let map = this.items.get(ext.id);
    if (!map) {
      map = new Map();
      this.items.set(ext.id, map);
    }
    const id = props.id ?? "zl-menu-" + ++this.seq;
    if (map.has(id)) throw new Error("zeolite: contextMenus.create: duplicate id: " + id);
    if (props.parentId !== undefined && !map.has(props.parentId)) {
      throw new Error("zeolite: contextMenus.create: no such parent: " + props.parentId);
    }
    map.set(id, {
      id,
      extId: ext.id,
      title: props.title ?? "",
      contexts: props.contexts ?? ["page"],
      parentId: props.parentId ?? null,
      type: props.type ?? "normal",
      enabled: props.enabled ?? true,
    });
    return id;
  }

  update(ext: ExtensionRecord, id: string, props: Partial<MenuProps>): void {
    const it = this.items.get(ext.id)?.get(id);
    if (!it) throw new Error("zeolite: contextMenus.update: no such item: " + id);
    if (props.title !== undefined) it.title = props.title;
    if (props.contexts !== undefined) it.contexts = props.contexts;
    if (props.enabled !== undefined) it.enabled = props.enabled;
  }

  remove(ext: ExtensionRecord, id: string): void {
    const map = this.items.get(ext.id);
    if (!map?.delete(id)) throw new Error("zeolite: contextMenus.remove: no such item: " + id);
  }

  removeAll(ext: ExtensionRecord): void {
    this.items.delete(ext.id);
  }

  onClicked(id: ExtensionId, l: MenuClickListener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(l);
    return () => set?.delete(l);
  }

  /** All registered items across extensions, for the engine UI. */
  list(): MenuItem[] {
    const out: MenuItem[] = [];
    for (const map of this.items.values()) for (const it of map.values()) out.push({ ...it });
    return out;
  }

  listFor(extId: ExtensionId): MenuItem[] {
    const out: MenuItem[] = [];
    for (const it of this.items.get(extId)?.values() ?? []) out.push({ ...it });
    return out;
  }

  /** A click reported by the engine UI. */
  click(extId: ExtensionId, id: string, tabId: number | null): void {
    const it = this.items.get(extId)?.get(id);
    if (!it || !it.enabled) return;
    const set = this.listeners.get(extId);
    if (!set || set.size === 0) return;
    const rec = extensions.get(extId);
    const tab = tabId !== null ? TABS.get(tabId) : null;
    const tview = rec && tab ? tabView(rec, tab) : undefined;
    const info: Record<string, unknown> = {
      menuItemId: id,
      parentMenuItemId: it.parentId,
      contexts: it.contexts,
    };
    for (const l of [...set]) {
      try {
        l(info, tview);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
  }
}

export const MENUS = new ContextMenusRegistry();
