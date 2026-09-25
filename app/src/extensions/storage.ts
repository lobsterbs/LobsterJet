/* Zeolite extension subsystem: browser.storage.

   Areas are namespaced per extension id and per area. local and sync
   persist in IndexedDB across restarts; session is in-memory only,
   matching Firefox semantics. Values are JSON-serialized; a quota is
   enforced on local and sync. Storage here is fully isolated from
   proxied website storage (bootstrap.ts scopes that separately) and
   from every other extension. */

import type { ExtensionId } from "./types";
import { idbGetAll, idbPut, openDb, STORE_STORAGE } from "./idb";

export type StorageAreaName = "local" | "sync" | "session";
export type StorageValue = null | boolean | number | string | StorageValue[] | { [k: string]: StorageValue };
export type StorageChange = { oldValue: StorageValue | undefined; newValue: StorageValue | undefined };
export type ChangeListener = (changes: Record<string, StorageChange>, area: string) => void;

const QUOTA_BYTES = { local: 5 * 1024 * 1024, sync: 1024 * 1024, session: 1 * 1024 * 1024 };
const PREFIX = (id: ExtensionId, area: StorageAreaName, key: string): string =>
  id + ":" + area + ":" + key;

/* JSON round-trip both validates the value shape (no undefined, no
   cycles, no functions) and gives us the byte size for the quota. */
function freeze(v: unknown): { ok: boolean; json: string } {
  try {
    const json = JSON.stringify(v);
    if (json === undefined) return { ok: false, json: "" };
    return { ok: true, json };
  } catch {
    return { ok: false, json: "" };
  }
}

function thaw(json: string): StorageValue {
  return JSON.parse(json) as StorageValue;
}

export class ExtensionStorageArea {
  private readonly mem = new Map<string, string>();
  private readonly listeners = new Set<ChangeListener>();
  private bytesInUse = 0;

  constructor(
    private readonly id: ExtensionId,
    readonly name: StorageAreaName,
    private readonly area: "local" | "sync" | "session"
  ) {}

  private storageKey(key: string): string {
    return PREFIX(this.id, this.area, key);
  }

  async load(db: IDBDatabase): Promise<void> {
    if (this.area === "session") return;
    const rows = (await idbGetAll(db, STORE_STORAGE)) as Array<[string, string]>;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2) continue;
      const [k, json] = row;
      if (typeof k !== "string" || typeof json !== "string") continue;
      const prefix = this.id + ":" + this.area + ":";
      if (!k.startsWith(prefix)) continue;
      this.mem.set(k.slice(prefix.length), json);
    }
    this.recount();
  }

  private recount(): void {
    let n = 0;
    for (const json of this.mem.values()) n += json.length;
    this.bytesInUse = n;
  }

  async get(keys?: string | string[] | Record<string, StorageValue> | null): Promise<Record<string, StorageValue>> {
    const out: Record<string, StorageValue> = {};
    if (keys === undefined || keys === null) {
      for (const [k, json] of this.mem) out[k] = thaw(json);
      return out;
    }
    const wanted: string[] = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const defaults: Record<string, StorageValue> = typeof keys === "object" && !Array.isArray(keys) ? keys : {};
    for (const k of wanted) {
      const json = this.mem.get(k);
      out[k] = json !== undefined ? thaw(json) : (defaults[k] ?? null);
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    const db = this.area === "session" ? null : await openDb();
    const changes: Record<string, StorageChange> = {};
    for (const [k, v] of Object.entries(items)) {
      const frozen = freeze(v);
      if (!frozen.ok) throw new Error("zeolite: storage.set: value for '" + k + "' is not serializable");
      if (this.bytesInUse - (this.mem.get(k)?.length ?? 0) + frozen.json.length > QUOTA_BYTES[this.name]) {
        throw new Error("zeolite: storage." + this.name + " quota exceeded");
      }
      const old = this.mem.get(k);
      this.mem.set(k, frozen.json);
      if (db) await idbPut(db, STORE_STORAGE, this.storageKey(k), frozen.json);
      changes[k] = { oldValue: old !== undefined ? thaw(old) : undefined, newValue: v as StorageValue };
    }
    this.recount();
    for (const l of this.listeners) l(changes, this.name);
  }

  async remove(keys: string | string[]): Promise<void> {
    const db = this.area === "session" ? null : await openDb();
    const list = typeof keys === "string" ? [keys] : keys;
    const changes: Record<string, StorageChange> = {};
    for (const k of list) {
      const old = this.mem.get(k);
      if (old === undefined) continue;
      this.mem.delete(k);
      if (db) await idbPut(db, STORE_STORAGE, this.storageKey(k), null);
      changes[k] = { oldValue: thaw(old), newValue: undefined };
    }
    this.recount();
    for (const l of this.listeners) l(changes, this.name);
  }

  async clear(): Promise<void> {
    const keys = [...this.mem.keys()];
    await this.remove(keys);
  }

  async getBytesInUse(keys?: string | string[]): Promise<number> {
    if (keys === undefined) return this.bytesInUse;
    const list = typeof keys === "string" ? [keys] : keys;
    let n = 0;
    for (const k of list) n += this.mem.get(k)?.length ?? 0;
    return n;
  }

  addListener(l: ChangeListener): void {
    this.listeners.add(l);
  }

  removeListener(l: ChangeListener): void {
    this.listeners.delete(l);
  }
}
