import { describe, expect, it } from "vitest";
import { ExtensionMessenger } from "../messaging";

const ID = "c".repeat(32);
const sender = { extensionId: ID, context: "background" as const, url: null };

describe("ExtensionMessenger", () => {
  it("rejects when no listener exists", async () => {
    const m = new ExtensionMessenger();
    await expect(m.sendMessage(ID, sender, { hi: 1 })).rejects.toThrow(/Receiving end/);
  });
  it("delivers to listeners and resolves the reply", async () => {
    const m = new ExtensionMessenger();
    m.onMessage(ID, (msg, from, send) => {
      expect(msg).toEqual({ hi: 1 });
      expect(from.extensionId).toBe(ID);
      send({ pong: true });
    });
    await expect(m.sendMessage(ID, sender, { hi: 1 })).resolves.toEqual({ pong: true });
  });
  it("resolves undefined for sync listeners that do not keep the channel open", async () => {
    const m = new ExtensionMessenger();
    m.onMessage(ID, () => {
      /* returns undefined: no async response */
    });
    await expect(m.sendMessage(ID, sender, {})).resolves.toBeUndefined();
  });
  it("refuses cross-extension sends", async () => {
    const m = new ExtensionMessenger();
    await expect(m.sendMessage("d".repeat(32), sender, {})).rejects.toThrow(
      /cross-extension/,
    );
  });
  it("runs ports end to end", () => {
    const m = new ExtensionMessenger();
    let got: unknown = null;
    m.onConnect(ID, (port) => {
      expect(port.name).toBe("chan");
      port.onMessage((msg) => {
        got = msg;
        port.postMessage({ echo: msg });
      });
    });
    const mine = m.connect(ID, "chan", sender);
    const seen: unknown[] = [];
    mine.onMessage((msg) => seen.push(msg));
    mine.postMessage({ a: 1 });
    expect(got).toEqual({ a: 1 });
    expect(seen).toEqual([{ echo: { a: 1 } }]);
    mine.disconnect();
    expect(mine.isConnected).toBe(false);
  });
});
