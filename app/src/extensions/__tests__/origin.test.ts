import { describe, expect, it } from "vitest";
import {
  extensionUrl,
  normalizeExtensionPath,
  parseExtensionUrl,
} from "../origin";

const ID = "a".repeat(32);

describe("extension paths", () => {
  it("normalizes duplicate slashes", () => {
    expect(normalizeExtensionPath("/a//b/./c")).toBe("/a/b/c");
  });
  it("rejects traversal", () => {
    expect(normalizeExtensionPath("/a/../b")).toBeNull();
    expect(normalizeExtensionPath("/a/..%2Fb")).not.toBeNull(); // literal %2F is just a name
  });
  it("rejects backslashes and relative paths", () => {
    expect(normalizeExtensionPath("/a\\b")).toBeNull();
    expect(normalizeExtensionPath("a/b")).toBeNull();
  });
});

describe("extension urls", () => {
  it("round-trips id and path", () => {
    const u = parseExtensionUrl("extension://" + ID + "/popup.html");
    expect(u?.id).toBe(ID);
    expect(u?.path).toBe("/popup.html");
  });
  it("rejects spoofed ids", () => {
    expect(parseExtensionUrl("extension://" + "A".repeat(32) + "/x")).toBeNull();
    expect(parseExtensionUrl("extension://short/x")).toBeNull();
    expect(parseExtensionUrl("https://" + ID + "/x")).toBeNull();
  });
  it("extensionUrl refuses unsafe paths", () => {
    expect(extensionUrl(ID, "ok.js")).toBe("extension://" + ID + "/ok.js");
    expect(() => extensionUrl(ID, "../escape")).toThrow();
  });
});
