/* Zeolite extension subsystem: advanced permissions.

   The browser.permissions API: contains/getAll read the granted set,
   request/remove run through a manager-backed backend (wired by the
   service worker exactly like the tabs bridge, so grants mutate and
   persist the master record). The engine has no user prompt, so
   request() auto-grants anything the manifest declared in
   optional_permissions and refuses everything else: no extension can
   self-escalate past its manifest. onAdded/onRemoved fire with the
   requested set. */

import type { ExtensionId, ExtensionRecord } from "./types";

export interface ApiPermissions {
  permissions?: string[];
  origins?: string[];
}

export type PermListener = (perms: ApiPermissions) => void;

export type PermBackend = (
  id: ExtensionId,
  op: "grant" | "revoke",
  perms: ApiPermissions,
) => Promise<{ permissions: string[]; origins: string[] } | null>;

export class PermissionRegistry {
  private backend: PermBackend | null = null;
  private readonly added = new Set<PermListener>();
  private readonly removed = new Set<PermListener>();
  /* Live view per extension: the API object is built from a record
     snapshot, so grants must be observable without a reload. */
  private readonly views = new Map<ExtensionId, { permissions: string[]; origins: string[] }>();

  setBackend(b: PermBackend | null): void {
    this.backend = b;
  }

  private fire(listeners: Set<PermListener>, perms: ApiPermissions): void {
    for (const l of listeners) {
      try {
        l({
          permissions: [...(perms.permissions ?? [])],
          origins: [...(perms.origins ?? [])],
        });
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
  }

  subscribeAdded(l: PermListener): () => void {
    this.added.add(l);
    return () => this.added.delete(l);
  }

  subscribeRemoved(l: PermListener): () => void {
    this.removed.add(l);
    return () => this.removed.delete(l);
  }

  private view(ext: ExtensionRecord): { permissions: string[]; origins: string[] } {
    let v = this.views.get(ext.id);
    if (!v) {
      v = { permissions: [...ext.permissions], origins: [...ext.hostPermissions] };
      this.views.set(ext.id, v);
    }
    return v;
  }

  contains(ext: ExtensionRecord, perms: ApiPermissions): boolean {
    const v = this.view(ext);
    const named = perms.permissions ?? [];
    const origins = perms.origins ?? [];
    return (
      named.every((p) => v.permissions.includes(p)) &&
      origins.every((p) => v.origins.includes(p))
    );
  }

  getAll(ext: ExtensionRecord): { permissions: string[]; origins: string[] } {
    const v = this.view(ext);
    return { permissions: [...v.permissions], origins: [...v.origins] };
  }

  async request(ext: ExtensionRecord, perms: ApiPermissions): Promise<boolean> {
    if (!this.backend) return false;
    /* The backend mutates the live record object this closure holds,
       so the delta must be computed against a snapshot taken BEFORE
       the grant, or onAdded never fires. */
    const prior = new Set(ext.permissions);
    const priorHost = new Set(ext.hostPermissions);
    const after = await this.backend(ext.id, "grant", perms);
    if (!after) return false;
    const newlyGranted =
      (perms.permissions ?? []).some((p) => !prior.has(p)) ||
      (perms.origins ?? []).some((p) => !priorHost.has(p));
    this.views.set(ext.id, after);
    if (newlyGranted) this.fire(this.added, perms);
    return true;
  }

  async remove(ext: ExtensionRecord, perms: ApiPermissions): Promise<boolean> {
    if (!this.backend) return false;
    const prior = new Set(ext.permissions);
    const priorHost = new Set(ext.hostPermissions);
    const after = await this.backend(ext.id, "revoke", perms);
    if (!after) return false;
    const wasGranted =
      (perms.permissions ?? []).some((p) => prior.has(p)) ||
      (perms.origins ?? []).some((p) => priorHost.has(p));
    this.views.set(ext.id, after);
    if (wasGranted) this.fire(this.removed, perms);
    return true;
  }
}

export const PERMS = new PermissionRegistry();
