/* Zeolite extension subsystem: extension origin.

   Every extension lives at extension://<32-hex-id>/... and its
   resources resolve exclusively through the extension resource loader.
   Parsing rejects id spoofing, null bytes, backslashes, absolute
   escapes and any .. segment at the boundary, so traversal cannot get
   past this module. */

export const EXT_SCHEME = "extension://";
export const EXT_ID_RE = /^[a-f0-9]{32}$/;

export interface ExtensionUrl {
  id: string;
  path: string;
}

export function isExtensionUrl(u: string): boolean {
  return parseExtensionUrl(u) !== null;
}

export function parseExtensionUrl(u: string): ExtensionUrl | null {
  if (!u.startsWith(EXT_SCHEME)) return null;
  const rest = u.slice(EXT_SCHEME.length);
  const slash = rest.indexOf("/");
  const id = slash === -1 ? rest : rest.slice(0, slash);
  if (!EXT_ID_RE.test(id)) return null;
  const rawPath = slash === -1 ? "/" : rest.slice(slash);
  const path = normalizeExtensionPath(rawPath);
  if (path === null) return null;
  return { id, path };
}

/* Returns the canonical /a/b/c form or null when the path is unsafe.
   Extension resource paths are strictly relative inside the package:
   no .., no absolute escapes, no backslashes, no NUL. */
export function normalizeExtensionPath(p: string): string | null {
  if (p.includes("\u0000")) return null;
  if (p.includes("\\")) return null;
  if (!p.startsWith("/")) return null;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

export function extensionUrl(id: string, path: string): string {
  const norm = normalizeExtensionPath(path.startsWith("/") ? path : "/" + path);
  if (norm === null) {
    throw new Error("zeolite: unsafe extension resource path: " + path);
  }
  return EXT_SCHEME + id + norm;
}
