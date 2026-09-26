import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions, ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { TABS } from "../tabs";
import { SCRIPTING } from "../scripting";
import { WEBNAV } from "../webnavigation";
import { MENUS } from "../contextmenus";
import { DOWNLOADS } from "../downloads";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

function pkg(name: string, perms: string[], files: Record<string, string> = {}): Map<string, Uint8Array> {
  const manifest = { manifest_version: 2, name, version: "1.0", permissions: perms };
  const m = new Map<string, Uint8Array>([["manifest.json", enc.encode(JSON.stringify(manifest))]]);
  for (const [k, v] of Object.entries(files)) m.set(k, enc.encode(v));
  return m;
}

/* Installs into the singleton manager so the singleton-backed hosts
   (scripting reads files through it) see the package. */
async function install(name: string, perms: string[], files: Record<string, string> = {}): Promise<{ rec: ExtensionRecord; api: { browser: Record<string, unknown>; chrome: Record<string, unknown> } }> {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name, perms, files));
  const rec = extensions.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  return {
    rec,
    api: buildApi(rec, { extensionId: id, context: "background", url: null }, { messenger: new ExtensionMessenger(), storage }),
  };
}

function syncTab(id: number, url: string, active = true): void {
  TABS.syncFromUi([{ id, index: id, url, title: "t" + id, active }]);
}

describe("browser.scripting", () => {
  it("reads files and dispatches to the page channel with permission checks", async () => {
    TABS.setDispatch(() => undefined);
    syncTab(1, "https://example.com/page");
    const { rec, api } = await install("Scripty", ["scripting"], { "inj.js": "// injected" });
    const sent: unknown[] = [];
    SCRIPTING.setDispatch((m) => sent.push(m));
    const scripting = api.browser.scripting as Record<string, unknown>;
    await (scripting.executeScript as (i: unknown) => Promise<void>)({ target: { tabId: 1 }, files: ["inj.js"] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "zl:scripting",
      extId: rec.id,
      dest: "https://example.com/page",
      js: ["// injected"],
    });
    await (scripting.insertCSS as (i: unknown) => Promise<void>)({ target: { tabId: 1 }, files: ["inj.js"] });
    expect(sent[1]).toMatchObject({ css: ["// injected"], js: [] });
    SCRIPTING.setDispatch(null);
  });

  it("enforces scripting + host permissions and missing files", async () => {
    TABS.setDispatch(() => undefined);
    syncTab(2, "https://example.com/x");
    syncTab(3, "https://other.example/y");
    const noPerm = await install("NoScripting", []);
    const wrongHost = await install("WrongHost", ["scripting"]);
    const noFile = await install("NoFile", ["scripting"], { "a.js": "//" });
    const sp = (a: { api: { browser: Record<string, unknown> } }) =>
      a.api.browser.scripting as Record<string, unknown>;
    SCRIPTING.setDispatch(() => undefined);
    await expect(
      (sp(noPerm).executeScript as (i: unknown) => Promise<void>)({ target: { tabId: 2 }, files: [] }),
    ).rejects.toThrow(/permission 'scripting'/);
    await expect(
      (sp(wrongHost).executeScript as (i: unknown) => Promise<void>)({ target: { tabId: 3 }, files: [] }),
    ).rejects.toThrow(/host permission/);
    await expect(
      (sp(noFile).executeScript as (i: unknown) => Promise<void>)({ target: { tabId: 2 }, files: ["missing.js"] }),
    ).rejects.toThrow(/not found in extension package/);
    await expect(
      (sp(noFile).executeScript as (i: unknown) => Promise<void>)({ target: { tabId: 99 }, files: [] }),
    ).rejects.toThrow(/Invalid tab ID/);
    SCRIPTING.setDispatch(null);
  });
});

describe("browser.webNavigation", () => {
  it("delivers onCommitted for known tabs only, permission-gated", async () => {
    TABS.setDispatch(() => undefined);
    TABS.syncFromUi([{ id: 7, index: 7, url: "https://example.com/", title: "t", active: true }]);
    const { api } = await install("Phase2Nav", ["webNavigation"]);
    const nav = api.browser.webNavigation as Record<string, unknown>;
    const seen: unknown[] = [];
    ((nav.onCommitted as { addListener: (l: (i: unknown) => void) => void }).addListener)((i) =>
      seen.push(i),
    );
    WEBNAV.committed("https://example.com/");
    WEBNAV.committed("https://unknown.example/");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tabId: 7, url: "https://example.com/", frameId: 0 });
  });
});

describe("browser.contextMenus / menus", () => {
  it("registers items and delivers clicks", async () => {
    const { rec, api } = await install("MenuExt", ["contextMenus"]);
    const cm = api.browser.contextMenus as Record<string, unknown>;
    expect((cm.create as (p: Record<string, unknown>) => string | number)({ id: "go", title: "Go" })).toBe("go");
    expect(
      (cm.create as (p: Record<string, unknown>) => string | number)({ title: "Auto" }),
    ).toBeGreaterThan(0);
    expect(MENUS.itemsFor(rec.id)).toHaveLength(2);
    const seen: unknown[] = [];
    ((cm.onClicked as { addListener: (l: (i: unknown, t: unknown) => void) => void }).addListener)((i, t) =>
      seen.push([i, t]),
    );
    MENUS.click(rec.id, { menuItemId: "go", pageUrl: "https://example.com/" }, { id: 1 });
    expect(seen[0]).toEqual([{ menuItemId: "go", pageUrl: "https://example.com/" }, { id: 1 }]);
    (cm.remove as (id: string) => void)("go");
    expect(MENUS.itemsFor(rec.id)).toHaveLength(1);
    (cm.removeAll as () => void)();
    expect(MENUS.itemsFor(rec.id)).toHaveLength(0);
  });

  it("requires the contextMenus/menus permission", async () => {
    const { api } = await install("NoMenu", []);
    const cm = api.browser.menus as Record<string, unknown>;
    expect(() =>
      (cm.create as (p: Record<string, unknown>) => string | number)({ title: "x" }),
    ).toThrow(/permission 'contextMenus'/);
  });
});

describe("browser.downloads", () => {
  it("hands downloads to the UI host with ids", async () => {
    const { api } = await install("DlExt", ["downloads"]);
    const ops: unknown[] = [];
    DOWNLOADS.setDispatch((op) => ops.push(op));
    const dl = api.browser.downloads as Record<string, unknown>;
    const id1 = await (dl.download as (o: Record<string, unknown>) => Promise<number>)({ url: "https://example.com/f.bin", filename: "f.bin" });
    const id2 = await (dl.download as (o: Record<string, unknown>) => Promise<number>)({ url: "https://example.com/g.bin" });
    expect(id2).toBe(id1 + 1);
    expect(ops[0]).toMatchObject({ op: "download", id: id1, url: "https://example.com/f.bin", filename: "f.bin" });
    DOWNLOADS.setDispatch(null);
  });

  it("enforces the downloads permission and url requirement", async () => {
    const noPerm = await install("NoDl", []);
    const dl = noPerm.api.browser.downloads as Record<string, unknown>;
    await expect(
      (dl.download as (o: Record<string, unknown>) => Promise<number>)({ url: "https://example.com/" }),
    ).rejects.toThrow(/permission 'downloads'/);
    DOWNLOADS.setDispatch(() => undefined);
    const has = await install("DlUrl", ["downloads"]);
    const dl2 = has.api.browser.downloads as Record<string, unknown>;
    await expect((dl2.download as (o: Record<string, unknown>) => Promise<number>)({})).rejects.toThrow(/requires a url/);
    DOWNLOADS.setDispatch(null);
  });
});
