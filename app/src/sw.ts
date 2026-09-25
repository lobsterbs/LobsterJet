/* Zeolite service worker: interception + header surgery + streaming
   rewriter + wisp transport + SiteConfig rules + plugin hooks + the
   network inspector's log.

   URL shape: engine-local routes under a configurable prefix (default
   /j/, rotatable at runtime via an zl:config message). Requests that
   are engine assets (sw.js, bootstrap.js, devtools.html, ...) or the
   wisp endpoint pass through untouched. All prefix/scheme decisions go
   through ./codec helpers (bug-scout fix: "/j/" was previously hard
   -coded here while decoding used the rotated prefix).

   Phase 2 control plane (postMessage from the engine adapter):
     { type: "zl:config", prefix, scheme }   rotate the URL shape
     { type: "zl:siteRoute", site, enabled } per-site interception toggle
     { type: "zl:teardown" }                 unregister + drop caches
   Phase 4 control plane:
     { type: "zl:getNetLog" }                snapshot of the request log
   Replies are posted back on the given MessageChannel port, so the
   adapter (and the devtools page) get real acknowledgements.

   The rewriter wasm (wasm-bindgen output of crates/rewriter) is emitted
   by the build pipeline to src/rewriter_wasm/ (see workflow:
   wasm-pack build --target web -> copy into app/src/rewriter_wasm). */

/// <reference lib="webworker" />
import { decodePath, isEnginePath, setScheme, currentPrefix } from "./codec";
import { ZL_WISP_URL } from "./config";
import { ruleFor, siteRules } from "./siteconfig";
import { applyOnRequest, applyOnResponse } from "./plugins";

declare const self: ServiceWorkerGlobalScope;

/* ---- HTTP over wisp ----------------------------------------------- */
/* Phase 1: libcurl wasm transport (BareMux-compatible), the same proven
   TLS-termination path Scramjet uses. Vendored build replaces
   src/libcurl-transport-vendored.ts; until then calls throw and the
   suite records transport-missing. */

let curlReady: Promise<void> | null = null;
async function ensureCurl(): Promise<void> {
  if (!curlReady) {
    curlReady = (async () => {
      const mod = await import("./libcurl-transport-vendored");
      await mod.init({ websocket: ZL_WISP_URL });
    })();
  }
  return curlReady;
}

async function wispFetch(dest: string, init?: RequestInit): Promise<Response> {
  await ensureCurl();
  const mod = await import("./libcurl-transport-vendored");
  return mod.fetch(dest, init);
}

/* ---- Header surgery ------------------------------------------------ */

const HOSTILE = [
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
];

function stripHostile(headers: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of headers) {
    if (!HOSTILE.includes(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

/* ---- Streaming rewriter wiring ------------------------------------- */

interface JsRewriter {
  process(chunk: string): string;
  finish(): string;
  add_injection(path: string): void;
  set_blocked_hosts(hosts: string[]): void;
}
interface RewriterMod {
  JsRewriter: new (origin: string, base: string, prefix: string) => JsRewriter;
  rewriteCss(css: string, origin: string, base: string, prefix: string): string;
}
let rewriterMod: Promise<RewriterMod> | null = null;
function rewriter(): Promise<RewriterMod> {
  if (!rewriterMod) rewriterMod = import("./rewriter_wasm/rewriter_wasm.js");
  return rewriterMod;
}

function isHtml(resp: Response): boolean {
  return (resp.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}
function isCss(resp: Response): boolean {
  return (resp.headers.get("content-type") ?? "").toLowerCase().includes("text/css");
}

/** HTML bodies: pipe response chunks through the wasm rewriter. The
    bootstrap needs the page's real destination on window.__ZL, so we
    emit a tiny inline script before the first rewritten chunk.
    SiteConfig per-site rules are applied to this rewriter instance:
    injections (Phase 3 hooks) and blocked hosts (ad stripping). */
function rewriteStream(
  body: ReadableStream<Uint8Array>,
  base: string,
  rule: { inject?: string[]; block?: string[] },
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const modP = rewriter();
  const ljInit = `<script>window.__ZL=${JSON.stringify({ dest: base })};</script>`;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(ljInit));
      const mod = await modP;
      const rw = new mod.JsRewriter(self.location.origin, base, currentPrefix());
      for (const path of rule.inject ?? []) rw.add_injection(path);
      if (rule.block?.length) rw.set_blocked_hosts(rule.block);
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = rw.finish();
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.close();
            return;
          }
          const out = rw.process(decoder.decode(value, { stream: true }));
          if (out) controller.enqueue(encoder.encode(out));
        }
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

/* ---- Network inspector log (Phase 4) -------------------------------- */
/* Fixed-size ring buffer of proxied requests. The devtools page polls
   zl:getNetLog; a snapshot plus a monotonically increasing sequence
   lets it drop entries it has already seen. */

export interface NetEntry {
  seq: number;
  ts: number;
  method: string;
  /** Engine-local request path. */
  path: string;
  /** Real destination URL. */
  dest: string;
  status: number;
  /** Time until response headers (TTFB through the wisp hop), ms. */
  ms: number;
  /** Response body size: content-length when present, else -1. */
  bytes: number;
  /** Plugin verdict from the onRequest hooks, when any plugin ran. */
  verdict?: string;
  err?: string;
}

const NET_LIMIT = 256;
const netLog: NetEntry[] = [];
let netSeq = 0;

function netLogPush(entry: Omit<NetEntry, "seq" | "ts">): void {
  netLog.push({ ...entry, seq: ++netSeq, ts: Date.now() });
  if (netLog.length > NET_LIMIT) netLog.shift();
}

/* ---- Page cache (ported from the v3 worker) -------------------- */
/* Cache-first for proxied GETs with stale-while-revalidate. Freshness
   honors Cache-Control: max-age when present (no-store skips the cache
   entirely); the fallback TTL is 10 minutes. 60-entry cap, FIFO
   eviction. x-zl-cached-at carries the stored-at time. */

export const ZEOLITE_VERSION = "1.0 Nitride";
console.info("[Zeolite] runtime " + ZEOLITE_VERSION);

const ZL_PAGES = "zeolite-pages-v1";
const ZL_CACHED_AT = "x-zl-cached-at";
const ZL_DEFAULT_TTL = 10 * 60 * 1000;
const ZL_PAGE_LIMIT = 60;

function cacheTtl(headers: Headers): number {
  const cc = (headers.get("cache-control") ?? "").toLowerCase();
  if (/no-store/.test(cc)) return 0;
  const m = /(?:^|[,\s])max-age=(\d+)/.exec(cc);
  if (m) return Math.min(Number(m[1]) * 1000, 24 * 60 * 60 * 1000);
  return ZL_DEFAULT_TTL;
}

async function pageCacheMatch(req: Request): Promise<Response | null> {
  let hit: Response | undefined;
  try {
    hit = await (await caches.open(ZL_PAGES)).match(req);
  } catch {
    return null;
  }
  if (!hit) return null;
  const at = Number(hit.headers.get(ZL_CACHED_AT) ?? 0);
  const ttl = cacheTtl(hit.headers);
  if (!ttl) return null;
  if (Date.now() - at < ttl) return hit;
  /* Stale: serve it now, refresh in the background. */
  try {
    const fresh = await wispFetchCacheBypass(req);
    if (fresh.ok) await pageCacheStore(req, fresh);
  } catch {
    /* offline: the stale copy stays served */
  }
  return hit;
}

async function pageCacheStore(req: Request, resp: Response): Promise<void> {
  const ttl = cacheTtl(resp.headers);
  if (!ttl || resp.status !== 200) return;
  try {
    const cache = await caches.open(ZL_PAGES);
    const stored = new Response(resp.body, { status: 200, headers: resp.headers });
    stored.headers.set(ZL_CACHED_AT, String(Date.now()));
    await cache.put(req, stored);
    const keys = await cache.keys();
    while (keys.length > ZL_PAGE_LIMIT) {
      await cache.delete(keys.shift()!);
    }
  } catch {
    /* storage full or unavailable: skip caching */
  }
}

/** Re-fetch a cached request straight through the wisp transport. */
async function wispFetchCacheBypass(req: Request): Promise<Response> {
  const dest = decodePath(new URL(req.url).pathname) + new URL(req.url).search;
  return wispFetch(dest, { method: "GET", redirect: "follow" });
}

/* ---- Per-site route table ------------------------------------------ */

/** Sites the user disabled for this engine. Keyed by registrable-ish
    host suffix (match on hostname or any parent domain). */
const disabledSites = new Set<string>();

function siteDisabled(target: string): boolean {
  let host: string;
  try {
    host = new URL(target).hostname;
  } catch {
    return false;
  }
  for (const site of disabledSites) {
    if (host === site || host.endsWith("." + site)) return true;
  }
  return false;
}

/* ---- Fetch interception -------------------------------------------- */

self.addEventListener("install", () => {
  self.skipWaiting();
  /* Prewarm: instantiate the rewriter wasm during install, not on the
     first HTML response (instantiation is the slowest cold-path step). */
  void rewriter().catch(() => undefined);
});

let netGeneration = 0;

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      await self.clients.claim();
      /* Warm the transport so the first proxied request skips libcurl
         init. A missing vendored build just logs, as before. */
      netGeneration++;
      try {
        await ensureCurl();
      } catch {
        /* transport-missing: the suite records it, as before */
      }
    })(),
  );
});

self.addEventListener("fetch", (e: FetchEvent) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // not ours: browser handles it
  if (url.pathname.startsWith("/wisp/")) return; // transport endpoint: passthrough
  if (!isEnginePath(url.pathname)) return; // engine asset: passthrough

  const dest = decodePath(url.pathname);
  if (!dest) {
    e.respondWith(new Response("zeolite: bad route", { status: 404 }));
    return;
  }
  // Query string travels outside the encoded destination.
  const target = url.search ? dest + url.search : dest;

  if (siteDisabled(target)) {
    e.respondWith(
      new Response("zeolite: site disabled for this engine", {
        status: 403,
        headers: { "content-type": "text/plain" },
      }),
    );
    return;
  }

  e.respondWith(
    (async () => {
      const t0 = Date.now();
      /* Cache-first for proxied GETs. */
      if (e.request.method === "GET") {
        const hit = await pageCacheMatch(e.request);
        if (hit) {
          netLogPush({
            method: e.request.method,
            path: url.pathname + url.search,
            dest: target,
            status: hit.status,
            ms: Date.now() - t0,
            bytes: Number(hit.headers.get("content-length") ?? -1),
            verdict: "cache",
          });
          return hit;
        }
      }
      const rules = await siteRules();
      const rule = ruleFor(rules, target);
      const plugins = rule.plugins;
      try {
        const fwd = forwardedHeaders(e.request);
        await applyOnRequest(plugins, target, fwd);
        const resp = await wispFetch(target, {
          method: e.request.method,
          headers: fwd,
          body: ["GET", "HEAD"].includes(e.request.method) ? undefined : e.request.body,
          redirect: "follow",
        });
        const headers = stripHostile(resp.headers);
        headers.set("x-zl-proxy", "1");
        void applyOnResponse(plugins, target, resp.status, headers);
        netLogPush({
          method: e.request.method,
          path: url.pathname + url.search,
          dest: target,
          status: resp.status,
          ms: Date.now() - t0,
          bytes: Number(resp.headers.get("content-length") ?? -1),
          verdict: plugins.length ? "pass:" + plugins.length : undefined,
        });
        if (e.request.method === "GET") void pageCacheStore(e.request, resp.clone());
        if (isHtml(resp) && resp.body) {
          return new Response(rewriteStream(resp.body, target, rule), {
            status: resp.status,
            headers,
          });
        }
        if (isCss(resp) && resp.body) {
          // Standalone stylesheets: one-shot url() pass through the
          // rewriter module. Small bodies, not first-paint documents.
          const mod = await rewriter();
          const css = await resp.text();
          const out = mod.rewriteCss(css, self.location.origin, target, currentPrefix());
          return new Response(out, { status: resp.status, headers });
        }
        return new Response(resp.body, { status: resp.status, headers });
      } catch (err) {
        netLogPush({
          method: e.request.method,
          path: url.pathname + url.search,
          dest: target,
          status: 0,
          ms: Date.now() - t0,
          err: String(err),
        });
        return new Response(`zeolite: upstream fetch failed: ${String(err)}`, {
          status: 502,
          headers: { "content-type": "text/plain" },
        });
      }
    })(),
  );
});

/** Per-request header surgery: drop hop-by-hop + engine-origin leaks,
    restore the real destination as Referer. */
function forwardedHeaders(req: Request): Headers {
  const out = new Headers();
  const skip = new Set(["host", "connection", "referer", "origin"]);
  for (const [k, v] of req.headers) {
    if (!skip.has(k.toLowerCase())) out.set(k, v);
  }
  if (req.referrer) {
    const ref = decodePath(new URL(req.referrer, self.location.origin).pathname);
    if (ref) out.set("referer", ref);
  }
  if (!out.has("accept-language")) out.set("accept-language", "en-US,en;q=0.9");
  return out;
}

/* ---- Control plane (Phase 2 + Phase 4) ---------------------------- */

interface ControlMessage {
  type: "zl:config" | "zl:siteRoute" | "zl:teardown" | "zl:ping" | "zl:getNetLog";
  prefix?: string;
  scheme?: "b64u" | "mirror";
  site?: string;
  enabled?: boolean;
  /** Delta sync cursor for zl:getNetLog. */
  since?: number;
}

self.addEventListener("message", (e: ExtendableMessageEvent) => {
  const msg = e.data as ControlMessage;
  const port = e.ports[0];
  const reply = (payload: unknown) => port?.postMessage(payload);

  switch (msg?.type) {
    case "zl:ping":
      reply({ ok: true });
      break;
    case "zl:config":
      // Rotate the URL shape at runtime.
      setScheme(msg.prefix ?? "/j/", msg.scheme ?? "b64u");
      reply({ ok: true });
      break;
    case "zl:siteRoute":
      if (!msg.site) {
        reply({ ok: false, error: "missing site" });
        break;
      }
      if (msg.enabled === false) disabledSites.add(msg.site);
      else disabledSites.delete(msg.site);
      reply({ ok: true });
      break;
    case "zl:teardown":
      e.waitUntil(
        (async () => {
          // Drop every cache this SW owns, then unregister. Existing
          // pages lose their controller on next navigation; the adapter
          // also reloads them.
          const names = await caches.keys();
          await Promise.all(names.map((n) => caches.delete(n)));
          reply({ ok: true });
          await self.registration.unregister();
        })(),
      );
      break;
    case "zl:getNetLog": {
      // Delta sync: the devtools page sends the last seq it has seen and
      // gets only newer entries, so polling stays cheap at any ring size.
      const since = (msg as { since?: number }).since ?? 0;
      reply({ entries: netLog.filter((x) => x.seq > since), lastSeq: netSeq, generation: netGeneration,
          version: ZEOLITE_VERSION, });
      break;
    }
    default:
      reply({ ok: false, error: "unknown message" });
  }
});
