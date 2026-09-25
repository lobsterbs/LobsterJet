/* Zeolite extension subsystem: background runtime.

   Executes MV2 / Firefox-style MV3 background scripts. A service
   worker cannot spawn real isolated workers, so each extension's
   scripts run inside one Function scope receiving ONLY the extension
   API object: no access to the engine's real service-worker global,
   and no shared scope with other extensions. Multiple background
   scripts of one extension share that single scope, matching
   Firefox's single background global.

   Lifecycle: boot success -> RUNNING, boot failure -> ERROR with the
   message recorded on the extension (visible to the manager/UI); the
   engine itself never fails because an extension did. onInstalled
   fires on the extension's first-ever boot, onStartup on every later
   one; the marker persists in IndexedDB across SW restarts. */

import { extensions } from "./manager";
import { getExtensionContext } from "./context";
import { idbGet, idbPut, openDb, STORE_META } from "./idb";
import type { ExtensionRecord } from "./types";

const BOOT_MARKER = "zl-boot:";

export async function bootEnabled(): Promise<void> {
  for (const rec of extensions.list()) {
    if (!rec.enabled) continue;
    const bg = rec.background;
    if (!bg || (bg.scripts.length === 0 && !bg.page)) continue;
    try {
      await bootExtension(rec);
    } catch (e) {
      /* Recorded inside bootExtension; a broken extension must not
         stop the others from booting. */
      void e;
    }
  }
}

export async function bootExtension(rec: ExtensionRecord): Promise<void> {
  const live = extensions.get(rec.id);
  if (!live || !live.enabled) return;
  const ctx = await getExtensionContext(live);
  const db = await openDb();
  const first = (await idbGet(db, STORE_META, BOOT_MARKER + live.id)) === undefined;

  extensions.setState(live.id, "starting", null);
  try {
    const code: string[] = [];
    for (const s of live.background?.scripts ?? []) {
      const bytes = await extensions.getResource(live.id, s, { fromWeb: false });
      if (!bytes) throw new Error("background script missing from package: " + s);
      code.push(new TextDecoder().decode(bytes));
    }
    if (code.length === 0 && live.background?.page) {
      throw new Error(
        "background.page is not supported yet (Firefox-style background scripts are)",
      );
    }
    /* Function-scope execution: the scripts see only the API objects.
       self is a proxy over the API surface, NOT the real SW global. */
    const apiObj = ctx.api.browser as Record<string, unknown>;
    const sandboxSelf = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "addEventListener"
            ? () => undefined
            : apiObj[String(prop)],
      },
    ) as unknown as object;
    const fn = new Function(
      "browser",
      "chrome",
      "self",
      '"use strict";\n' + code.join("\n;\n"),
    );
    fn(ctx.api.browser, ctx.api.chrome, sandboxSelf);
    extensions.setState(live.id, "running", null);
  } catch (e) {
    extensions.setState(live.id, "error", "background: " + String(e));
  }

  /* Fire lifecycle events to whichever listeners the scripts just
     registered. Listener errors never fail the boot. */
  const rt = ctx.api.browser.runtime as unknown as {
    onInstalled: { _listeners: Set<(d: unknown) => void> };
    onStartup: { _listeners: Set<() => void> };
  };
  try {
    if (first) {
      for (const l of rt.onInstalled._listeners) l({ reason: "install" });
    } else {
      for (const l of rt.onStartup._listeners) l();
    }
  } catch {
    /* one bad listener must not break the rest */
  }
  await idbPut(db, STORE_META, BOOT_MARKER + live.id, Date.now());
}
