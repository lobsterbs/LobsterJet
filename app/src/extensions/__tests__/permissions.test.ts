import { describe, expect, it } from "vitest";
import {
  hostPatternMatches,
  hostPatternsMatch,
  parseHostPattern,
  PermissionGate,
} from "../permissions";

describe("host patterns", () => {
  it("parses <all_urls>", () => {
    const p = parseHostPattern("<all_urls>");
    expect(p?.all).toBe(true);
  });
  it("parses wildcard-subdomain patterns", () => {
    const p = parseHostPattern("https://*.example.com/*");
    expect(p?.scheme).toBe("https");
    expect(p?.host).toBe("*.example.com");
    expect(p?.path).toBe("/*");
  });
  it("rejects malformed patterns", () => {
    expect(parseHostPattern("nota pattern")).toBeNull();
    expect(parseHostPattern("https:///*")).toBeNull();
  });
  it("matches subdomains and the bare domain, not lookalikes", () => {
    const p = parseHostPattern("https://*.example.com/*")!;
    expect(hostPatternMatches(p, "https://a.example.com/x")).toBe(true);
    expect(hostPatternMatches(p, "https://example.com/")).toBe(true);
    expect(hostPatternMatches(p, "https://badexample.com/x")).toBe(false);
    expect(hostPatternMatches(p, "http://a.example.com/x")).toBe(false);
  });
  it("matches <all_urls> on the web schemes only", () => {
    const p = parseHostPattern("<all_urls>")!;
    expect(hostPatternMatches(p, "https://any.site/")).toBe(true);
    expect(hostPatternMatches(p, "file:///etc/passwd")).toBe(false);
  });
  it("hostPatternsMatch scans a list", () => {
    expect(hostPatternsMatch(["https://a.com/*", "https://b.com/*"], "https://b.com/x")).toBe(true);
    expect(hostPatternsMatch(["https://a.com/*"], "https://c.com/x")).toBe(false);
  });
});

describe("PermissionGate", () => {
  const gate = new PermissionGate(["tabs", "storage"], ["https://*.example.com/*"]);
  it("reports granted permissions", () => {
    expect(gate.has("tabs")).toBe(true);
    expect(gate.has("cookies")).toBe(false);
  });
  it("require throws for missing permissions", () => {
    expect(() => gate.require("tabs")).not.toThrow();
    expect(() => gate.require("cookies")).toThrow(/permission/);
  });
  it("enforces host permissions", () => {
    expect(gate.hasHost("https://a.example.com/")).toBe(true);
    expect(() => gate.requireHost("https://other.site/")).toThrow(/host permission/);
  });
});
