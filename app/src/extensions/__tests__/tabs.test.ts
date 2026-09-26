import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { TabRegistry, TABS, tabView } from "../tabs";
import type { TabsEvent, TabsOp, UiTab } from "../tabs";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";

const enc = new TextEncoder();

function pkg(name: string, permissions: string[]): Map<string, Uint8Array> {
  const manifest = { manifest_version: 2, name, version: "1.0", permissions };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
  ]);
}

function tab(id: number, url: string, extra: Partial<UiTab> = {}): UiTab {
  return { id, index: id, url, title: "t" + id, active: false, ...extra };
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
  return { id, api };
}

describe("TabRegistry", () => {
  it("diffs syncs into created/updated/activated/removed events", () => {
    const r = new TabRegistry();
    const events: TabsEvent[] = [];
    r.subscribe((e) => events.push(e));
    r.syncFromUi([tab(1, "https://a.example/", { active: true }), tab(2, "https://b.example/")]);
    expect(events.map((e) => e.type)).toEqual(["created", "created"]);
    r.syncFromUi([tab(1, "https://a.example/", { active: true }), tab(2, "https://c.example/")]);
    expect(events.map((e) => e.type)).toEqual(["created", "created", "updated"]);
    r.syncFromUi([tab(1, "https://a.example/", { active: true }), tab(2, "https://c.example/", { active: true })]);
    expect(events.map((e) => e.type)).toEqual(["created", "created", "updated", "updated", "activated"]);
    r.syncFromUi([tab(1, "https://a.example/", { active: true })]);
    expect(events[events.length - 1]).toMatchObject({ type: "removed", tabId: 2 });
  });

  it("queries on active and url patterns", () => {
    const r = new TabRegistry();
    r.syncFromUi([
      tab(1, "https://a.example/x", { active: true }),
      tab(2, "https://b.example/y"),
    ]);
    expect(r.query({ active: true }).map((t) => t.id)).toEqual([1]);
    expect(r.query({ url: "https://b.example/*" }).map((t) => t.id)).toEqual([2]);
    expect(r.query({})).toHaveLength(2);
    expect(r.get(1)?.url).toBe("https://a.example/x");
    expect(r.get(99)).toBeNull();
    expect(r.activeTab()?.id).toBe(1);
  });

  it("create resolves via the nonce marker", async () => {
    const r = new TabRegistry();
    r.syncFromUi([tab(1, "https://a.example/", { active: true })]);
    const ops: TabsOp[] = [];
    r.setDispatch((op) => ops.push(op));
    const p = r.create({ url: "https://c.example/" });
    expect(ops[0].op).toBe("create");
    expect(typeof ops[0].nonce).toBe("string");
    r.syncFromUi([
      tab(1, "https://a.example/", { active: true }),
      { ...tab(2, "https://c.example/"), nonce: ops[0].nonce },
    ]);
    const t = await p;
    expect(t.id).toBe(2);
    expect(r.get(2)?.nonce).toBeUndefined();
  });

  it("create rejects unsupported urls", async () => {
    const r = new TabRegistry();
    r.setDispatch(() => undefined);
    await expect(r.create({ url: "javascript:alert(1)" })).rejects.toThrow(/unsupported URL/);
  });

  it("rejects ops without a dispatch host", async () => {
    const r = new TabRegistry();
    await expect(r.create({ url: "https://a.example/" })).rejects.toThrow(/no tab host/);
    await expect(r.update(1, { active: true })).rejects.toThrow(/no tab host/);
    await expect(r.remove([1])).rejects.toThrow(/no tab host/);
  });

  it("remove and update resolve on observed change", async () => {
    const r = new TabRegistry();
    r.syncFromUi([tab(1, "https://a.example/", { active: true }), tab(2, "https://b.example/")]);
    r.setDispatch(() => undefined);
    const rm = r.remove([2]);
    const up = r.update(2, { active: true });
    r.syncFromUi([tab(1, "https://a.example/", { active: true })]);
    await rm;
    r.setDispatch(() => undefined);
    r.syncFromUi([tab(1, "https://a.example/"), tab(2, "https://b.example/", { active: true })]);
    await up;
  });
});

describe("browser.tabs (buildApi)", () => {
  const ops: TabsOp[] = [];

  it("exposes permission-gated tab views", async () => {
    TABS.setDispatch((op) => ops.push(op));
    TABS.syncFromUi([
      tab(10, "https://example.com/", { active: true }),
      tab(11, "https://other.example/"),
    ]);
    const withPerm = await apiFor("Tabsy", ["tabs"]);
    const withHost = await apiFor("Hosty", ["https://example.com/*"]);
    const bare = await apiFor("TabBare", []);
    const tabsOf = (a: { api: { browser: Record<string, unknown> } }) =>
      a.api.browser.tabs as Record<string, unknown>;

    const qAll = (await (tabsOf(withPerm).query as (q?: unknown) => Promise<Record<string, unknown>[]>)([])) as Record<string, unknown>[];
    expect(qAll[0]).toMatchObject({ id: 10, url: "https://example.com/" });

    const qBare = (await (tabsOf(bare).query as (q?: unknown) => Promise<Record<string, unknown>[]>)([])) as Record<string, unknown>[];
    expect(qBare[0]).not.toHaveProperty("url");
    expect(qBare[0]).not.toHaveProperty("title");
    expect(qBare[0]).toMatchObject({ id: 10, active: true });

    const qHost = (await (tabsOf(withHost).query as (q?: unknown) => Promise<Record<string, unknown>[]>)([])) as Record<string, unknown>[];
    expect(qHost.find((t) => t.id === 10)).toHaveProperty("url");
    expect(qHost.find((t) => t.id === 11)).not.toHaveProperty("url");

    await expect((tabsOf(bare).get as (id: number) => Promise<unknown>)(10)).resolves.toMatchObject({ id: 10 });
    await expect((tabsOf(bare).get as (id: number) => Promise<unknown>)(99)).rejects.toThrow(/Invalid tab ID/);
    await expect((tabsOf(bare).getCurrent as () => Promise<unknown>)()).rejects.toThrow(/tab context/);
    await expect(
      (tabsOf(bare).query as (q?: unknown) => Promise<unknown>)({ url: "https://example.com/*" }),
    ).rejects.toThrow(/requires the 'tabs' permission/);
    await expect(
      (tabsOf(withHost).query as (q?: unknown) => Promise<unknown>)({ url: "https://example.com/*" }),
    ).rejects.toThrow(/requires the 'tabs' permission/);
    await expect(
      (tabsOf(withPerm).query as (q?: unknown) => Promise<Record<string, unknown>[]>)({ url: "https://example.com/*" }),
    ).resolves.toHaveLength(1);
  });

  it("create/remove round-trip through dispatch ops", async () => {
    TABS.setDispatch((op) => ops.push(op));
    TABS.syncFromUi([tab(20, "https://example.com/", { active: true })]);
    const withPerm = await apiFor("Tabsy2", ["tabs"]);
    const tabsOf = withPerm.api.browser.tabs as Record<string, unknown>;
    const p = (tabsOf.create as (props: Record<string, unknown>) => Promise<Record<string, unknown>>)({ url: "https://new.example/" });
    const lastOp = ops[ops.length - 1];
    expect(lastOp.op).toBe("create");
    TABS.syncFromUi([
      tab(20, "https://example.com/", { active: true }),
      { ...tab(21, "https://new.example/", { active: true }), nonce: lastOp.nonce },
    ]);
    const created = await p;
    expect(created).toMatchObject({ id: 21, url: "https://new.example/" });

    const rm = (tabsOf.remove as (ids: number[]) => Promise<void>)([20]);
    expect(ops[ops.length - 1]).toMatchObject({ op: "remove", tabId: 20 });
    TABS.syncFromUi([{ ...tab(21, "https://new.example/", { active: true }) }]);
    await rm;
  });

  it("events fire with per-extension views", async () => {
    TABS.setDispatch(() => undefined);
    TABS.syncFromUi([tab(30, "https://example.com/", { active: true })]);
    const withPerm = await apiFor("Tabsy3", ["tabs"]);
    const bare = await apiFor("TabBare3", []);
    const seenPerm: Record<string, unknown>[] = [];
    const seenBare: Record<string, unknown>[] = [];
    ((withPerm.api.browser.tabs as Record<string, unknown>).onCreated as {
      addListener: (l: (t: Record<string, unknown>) => void) => void;
    }).addListener((t) => seenPerm.push(t));
    ((bare.api.browser.tabs as Record<string, unknown>).onCreated as {
      addListener: (l: (t: Record<string, unknown>) => void) => void;
    }).addListener((t) => seenBare.push(t));
    TABS.syncFromUi([
      tab(30, "https://example.com/", { active: true }),
      tab(31, "https://fresh.example/"),
    ]);
    expect(seenPerm[0]).toMatchObject({ id: 31, url: "https://fresh.example/" });
    expect(seenBare[0]).toMatchObject({ id: 31 });
    expect(seenBare[0]).not.toHaveProperty("url");
  });

  it("windows subset reflects the single window", async () => {
    TABS.setDispatch(() => undefined);
    TABS.syncFromUi([tab(40, "https://example.com/", { active: true })]);
    const withPerm = await apiFor("Tabsy4", ["tabs"]);
    const windows = withPerm.api.browser.windows as Record<string, unknown>;
    const all = (await (windows.getAll as (o?: { populate?: boolean }) => Promise<Record<string, unknown>[]>)({ populate: true })) as Record<string, unknown>[];
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 1, focused: true });
    expect((all[0] as { tabs?: { id: number }[] }).tabs).toEqual([{ id: 40 }].map((x) => expect.objectContaining(x)));
    await expect((windows.get as (id: number) => Promise<unknown>)(1)).resolves.toMatchObject({ id: 1 });
    await expect((windows.get as (id: number) => Promise<unknown>)(42)).rejects.toThrow(/Invalid window ID/);
    expect(windows.WINDOW_ID_CURRENT).toBe(-1);
  });
});
