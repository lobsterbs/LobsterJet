import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { SCRIPTING } from "../scripting";
import { MENUS } from "../contextmenus";
import { DOWNLOADS } from "../downloads";
import { TABS } from "../tabs";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import type { ScriptingOp, DownloadOp } from "../index";
import type { UiTab } from "../tabs";

const enc = new TextEncoder();

function pkg(name: string, permissions: string[]): Map<string, Uint8Array> {
  const manifest = { manifest_version: 2, name, version: "1.0", permissions };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
  ]);
}

async function apiFor(name: string, permissions: string[]) {
  const m = new ExtensionManager();
  await m.startup();
  const { id } = await m.installFiles(pkg(name, permissions));
  const rec = m.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const api = buildApi(rec, { extensionId: id, context: "background", url: null }, { messenger: new ExtensionMessenger(), storage });
  return { id, rec, api };
}

function tab(id: number, url: string, extra: Partial<UiTab> = {}): UiTab {
  return { id, index: id, url, title: "t" + id, active: false, ...extra };
}

describe("browser.scripting", () => {
  it("dispatches ops and resolves on ack; enforces permissions", async () => {
    const ops: ScriptingOp[] = [];
    SCRIPTING.setDispatch((op) => ops.push(op));
    TABS.syncFromUi([tab(1, "https://example.com/", { active: true })]);
    const withBoth = await apiFor("Scr", ["scripting", "https://example.com/*"]);
    const p = withBoth.api.browser.scripting as Record<string, unknown>;
    const exec = (p.executeScript as (i: { target: { tabId: number }; files: string[] }) => Promise<unknown[]>)({ target: { tabId: 1 }, files: ["cs.js"] });
    expect(ops[0]).toMatchObject({ extId: withBoth.id, tabId: 1, files: ["cs.js"], css: false });
    SCRIPTING.ack(ops[0].nonce, true, undefined, [{ ok: 1 }]);
    await expect(exec).resolves.toEqual([{ ok: 1 }]);
    const cssP = (p.insertCSS as (i: { target: { tabId: number }; files: string[] }) => Promise<void>)({ target: { tabId: 1 }, files: ["style.css"] });
    expect(ops[1].css).toBe(true);
    SCRIPTING.ack(ops[1].nonce, true);
    await cssP;
    const rej = (p.executeScript as (i: { target: { tabId: number }; files: string[] }) => Promise<unknown[]>)({ target: { tabId: 1 }, files: ["x.js"] });
    SCRIPTING.ack(ops[2].nonce, false, "page refused");
    await expect(rej).rejects.toThrow(/page refused/);

    const noHost = await apiFor("ScrNoHost", ["scripting"]);
    await expect(
      ((noHost.api.browser.scripting as Record<string, unknown>).executeScript as (i: { target: { tabId: number }; files: string[] }) => Promise<unknown[]>)({ target: { tabId: 1 }, files: ["x.js"] }),
    ).rejects.toThrow(/host permission/);
    const noPerm = await apiFor("ScrNoPerm", ["https://example.com/*"]);
    expect(noPerm.api.browser.scripting).toBeUndefined();
    await expect(
      SCRIPTING.executeScript(noPerm.rec, 1, ["x.js"]),
    ).rejects.toThrow(/'scripting' not granted/);
    await expect(
      SCRIPTING.executeScript(withBoth.rec, 99, ["x.js"]),
    ).rejects.toThrow(/Invalid tab ID/);
  });
});

describe("contextMenus", () => {
  it("registers, updates, routes clicks with tab views", async () => {
    const withPerm = await apiFor("Menu", ["contextMenus", "tabs"]);
    const bare = await apiFor("MenuBare", ["contextMenus"]);
    const menus = withPerm.api.browser.contextMenus as Record<string, unknown>;
    expect(bare.api.browser.menus).toBeUndefined();
    const create = menus.create as (p: Record<string, unknown>) => string;
    const id1 = create({ id: "go", title: "Go", contexts: ["page"] });
    expect(id1).toBe("go");
    expect(typeof create({ title: "auto" })).toBe("string");
    expect(() => create({ id: "go" })).toThrow(/duplicate/);
    (menus.update as (id: string, p: Record<string, unknown>) => void)("go", { title: "Go!" });

    const seen: unknown[] = [];
    (menus.onClicked as { addListener: (l: (info: Record<string, unknown>, tab: Record<string, unknown> | undefined) => void) => void }).addListener((info, tab) => seen.push({ info, tab }));
    TABS.syncFromUi([tab(1, "https://example.com/", { active: true })]);
    MENUS.click(withPerm.id, "go", 1);
    expect(seen[0]).toMatchObject({ info: { menuItemId: "go" }, tab: { id: 1, url: "https://example.com/" } });

    const bareSeen: unknown[] = [];
    MENUS.onClicked(bare.id, (info, tab) => bareSeen.push({ info, tab }));
    MENUS.click(bare.id, "go", 1);
    expect((bareSeen[0] as { tab: Record<string, unknown> }).tab).not.toHaveProperty("url");
    (menus.remove as (id: string) => void)("go");
    (menus.removeAll as () => void)();
    expect(MENUS.listFor(withPerm.id)).toHaveLength(0);
  });
});

describe("downloads", () => {
  it("dispatches, acks, and searches", async () => {
    const ops: DownloadOp[] = [];
    DOWNLOADS.setDispatch((op) => ops.push(op));
    const withPerm = await apiFor("Dl", ["downloads"]);
    const noPerm = await apiFor("DlNo", []);
    expect(noPerm.api.browser.downloads).toBeUndefined();
    const dl = withPerm.api.browser.downloads as Record<string, unknown>;
    const p = (dl.download as (o: { url: string; filename?: string }) => Promise<number>)({ url: "https://example.com/a.zip", filename: "a.zip" });
    expect(ops[0]).toMatchObject({ url: "https://example.com/a.zip", filename: "a.zip" });
    DOWNLOADS.ack(ops[0].nonce, true);
    const id = await p;
    DOWNLOADS.finish(id, "complete");
    const found = (await (dl.search as (q: Record<string, unknown>) => Promise<{ url: string; state: string }[]>)({ url: "example.com/.*" })) as { url: string; state: string }[];
    expect(found[0]).toMatchObject({ url: "https://example.com/a.zip", state: "complete" });
    const bad = (dl.download as (o: { url: string }) => Promise<number>)({ url: "https://example.com/b.zip" });
    DOWNLOADS.ack(ops[1].nonce, false, "blocked");
    await expect(bad).rejects.toThrow(/blocked/);
  });
});

describe("webNavigation", () => {
  it("fires on top-level url changes only with permission", async () => {
    const withPerm = await apiFor("Nav", ["webNavigation", "tabs"]);
    const noPerm = await apiFor("NavNo", []);
    expect(noPerm.api.browser.webNavigation).toBeUndefined();
    const nav = withPerm.api.browser.webNavigation as Record<string, unknown>;
    const seen: Record<string, unknown>[] = [];
    (nav.onCommitted as { addListener: (l: (d: Record<string, unknown>) => void) => void }).addListener((d) => seen.push(d));
    TABS.syncFromUi([tab(1, "https://example.com/one")]);
    TABS.syncFromUi([tab(1, "https://example.com/two")]);
    expect(seen[0]).toMatchObject({ tabId: 1, frameId: 0, url: "https://example.com/two", transitionType: "link" });
    expect(seen).toHaveLength(1);
  });
});
