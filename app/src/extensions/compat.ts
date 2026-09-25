/* Zeolite extension subsystem: compatibility matrix.

   Machine-readable, per API. "partial" means the surface exists with
   real behavior but known gaps; "no" entries carry the reason. This is
   the honest compatibility contract — nothing is listed as supported
   without an implementation behind it. */

export type CompatLevel = "yes" | "partial" | "no";

export interface CompatEntry {
  supported: CompatLevel;
  reason?: string;
}

export const COMPAT: Record<string, CompatEntry> = {
  "runtime.id": { supported: "yes" },
  "runtime.getManifest": { supported: "yes" },
  "runtime.getURL": { supported: "yes" },
  "runtime.sendMessage": { supported: "yes" },
  "runtime.onMessage": { supported: "yes" },
  "runtime.connect": { supported: "yes" },
  "runtime.onConnect": { supported: "yes" },
  "runtime.lastError": { supported: "yes" },
  "runtime.onInstalled": { supported: "no", reason: "fires only with the background runtime (next phase)" },
  "runtime.onStartup": { supported: "no", reason: "fires only with the background runtime (next phase)" },
  "runtime.onMessageExternal": { supported: "no", reason: "cross-extension messaging not implemented" },
  "storage.local": { supported: "yes" },
  "storage.sync": { supported: "partial", reason: "real API, but sync is local persistence only; no account backend" },
  "storage.session": { supported: "partial", reason: "in-memory as in Firefox, but per-context isolation pending the background runtime" },
  "content_scripts (manifest)": { supported: "partial", reason: "matching implemented; injection lands with the background runtime phase" },
  "browser.scripting": { supported: "no", reason: "depends on the content-script execution hook" },
  "tabs.*": { supported: "no", reason: "requires the LobsterBrowse tab model bridge" },
  "windows.*": { supported: "no", reason: "requires the LobsterBrowse window model bridge" },
  "cookies.*": { supported: "no", reason: "requires the Zeolite virtual cookie jar bridge" },
  "webRequest.*": { supported: "no", reason: "requires the Zeolite request decision engine bridge" },
  "webNavigation.*": { supported: "no", reason: "requires the Zeolite navigation lifecycle bridge" },
  "contextMenus.*": { supported: "no", reason: "requires the LobsterBrowse context menu integration" },
  "notifications.*": { supported: "no", reason: "requires the LobsterBrowse notification surface" },
  "downloads.*": { supported: "no", reason: "requires the Zeolite download manager bridge" },
  "management.*": { supported: "no", reason: "not started" },
  "background.service_worker (MV3)": { supported: "no", reason: "Firefox-style background scripts are the execution model; SW backgrounds recorded but not run" },
  "sidebar_action": { supported: "no", reason: "parsed and recorded; no sidebar host yet" },
  "popup pages": { supported: "no", reason: "extension-origin page hosting lands with the toolbar/popup phase" },
  "options pages": { supported: "no", reason: "extension-origin page hosting lands with the toolbar/popup phase" },
  "web_accessible_resources": { supported: "yes", reason: "glob exposure enforced by the resource loader" },
  "zip/xpi install": { supported: "yes" },
  "unpacked install": { supported: "yes" },
};

export function compatReport(): { api: string; supported: CompatLevel; reason?: string }[] {
  return Object.entries(COMPAT).map(([api, e]) => ({
    api,
    supported: e.supported,
    ...(e.reason ? { reason: e.reason } : {}),
  }));
}
