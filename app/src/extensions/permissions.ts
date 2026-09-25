/* Zeolite extension subsystem: permission model.

   Named permissions are validated against the Firefox permission set.
   Host patterns follow the Firefox match-pattern grammar:
   <all_urls> or scheme://host/path, where host may be *, *.domain, or a
   plain host, and path may contain one leading/trailing *. The
   PermissionGate is consulted before any privileged API executes. */

export const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set([
  "storage", "tabs", "scripting", "cookies", "webRequest",
  "webRequestBlocking", "webRequestFilterResponse", "activeTab",
  "notifications", "contextMenus", "menus", "downloads",
  "downloads.open", "downloads.ui", "history", "bookmarks",
  "management", "unlimitedStorage", "alarms", "idle", "privacy",
  "nativeMessaging", "geolocation", "clipboardRead", "clipboardWrite",
  "find", "browserSettings", "browsingData", "identity", "themes",
  "topSites", "webNavigation", "devtools", "dns", "pkcs11", "proxy",
  "sessions", "sidebarAction", "tabHide", "userScripts",
]);

export function isKnownPermission(p: string): boolean {
  return KNOWN_PERMISSIONS.has(p);
}

/* Matches the export in manifest.ts without a circular import. */
function looksLikeHostPattern(p: string): boolean {
  return p === "<all_urls>" || p.includes("://") || p.startsWith("*.");
}

export interface HostPattern {
  scheme: string;
  host: string;
  path: string;
  all: boolean;
}

export function parseHostPattern(p: string): HostPattern | null {
  if (p === "<all_urls>") return { scheme: "*", host: "*", path: "*", all: true };
  const m = /^(\*|https?|wss?|ftp|file|moz-extension|extension):\/\/([^\/]*)(\/.*)?$/.exec(p);
  if (!m) return null;
  const scheme = m[1] ?? "*";
  const host = m[2] ?? "";
  const path = m[3] ?? "/*";
  if (host === "") return null;
  if (scheme !== "*" && scheme !== "http" && scheme !== "https" &&
      scheme !== "ws" && scheme !== "wss" && scheme !== "ftp" &&
      scheme !== "file") {
    return null;
  }
  return { scheme, host, path, all: false };
}

function pathMatches(pat: string, p: string): boolean {
  if (pat === "*" || pat === "/*") return true;
  if (pat.startsWith("*") && pat.endsWith("*") && pat.length > 1) {
    return p.includes(pat.slice(1, -1));
  }
  if (pat.startsWith("*")) return p.endsWith(pat.slice(1));
  if (pat.endsWith("*")) return p.startsWith(pat.slice(0, -1));
  return pat === p;
}

export function hostPatternMatches(pat: HostPattern, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (pat.all) {
    return u.protocol === "http:" || u.protocol === "https:" ||
      u.protocol === "ws:" || u.protocol === "wss:" || u.protocol === "ftp:";
  }
  /* "*" covers http/https/ws/wss/ftp; anything else must be exact. */
  if (pat.scheme === "*") {
    const ok =
      u.protocol === "http:" || u.protocol === "https:" ||
      u.protocol === "ws:" || u.protocol === "wss:" || u.protocol === "ftp:";
    if (!ok) return false;
  } else if (pat.scheme + ":" !== u.protocol) {
    return false;
  }
  const hostOk =
    pat.host === "*" ||
    u.hostname === pat.host ||
    (pat.host.startsWith("*.") &&
      (u.hostname === pat.host.slice(2) || u.hostname.endsWith(pat.host.slice(1))));
  if (!hostOk) return false;
  return pathMatches(pat.path, u.pathname);
}

export function hostPatternsMatch(patterns: string[], url: string): boolean {
  for (const p of patterns) {
    const pat = parseHostPattern(p);
    if (pat && hostPatternMatches(pat, url)) return true;
  }
  return false;
}

export class PermissionGate {
  private readonly perms: ReadonlySet<string>;
  private readonly hosts: string[];

  constructor(permissions: string[], hostPermissions: string[]) {
    this.perms = new Set(permissions);
    this.hosts = hostPermissions;
  }

  has(p: string): boolean {
    return this.perms.has(p);
  }

  hasHost(url: string): boolean {
    return hostPatternsMatch(this.hosts, url);
  }

  require(p: string): void {
    if (!this.perms.has(p)) {
      throw new Error("zeolite: permission '" + p + "' not granted to this extension");
    }
  }

  requireHost(url: string): void {
    if (!this.hasHost(url)) {
      throw new Error("zeolite: host permission for '" + url + "' not granted to this extension");
    }
  }

  validate(requested: string[], diags: { warnings: string[] }): void {
    for (const p of requested) {
      if (!looksLikeHostPattern(p) && !isKnownPermission(p)) {
        diags.warnings.push("unknown permission: " + p);
      }
    }
  }
}
