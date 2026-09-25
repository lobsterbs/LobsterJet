# Power features spec (Phases 3-4)

This document pins the contracts for the four power subsystems so they can
be built independently but compose. Everything here extends the engine
adapter contract in docs/engine-adapter.md and never replaces it.

## 1. Plugin API (native extension support)

A plugin is a signed ES module shipped from the app origin, loaded only by
the engine service worker. No remote code, ever: a plugin that is not
served from the engine origin does not load. That is a security boundary,
not a limitation.

```ts
// app/src/plugins.ts (target contract)
export type LjPlugin = {
  id: string;                 // reverse-dns, e.g. "im.zeolite.adstrip"
  version: string;
  permissions: PluginPermission[];  // declared, user-granted
  hooks: Partial<PluginHooks>;
};

export type PluginPermission =
  | "observe:requests"        // read-only request/response metadata
  | "modify:responses"        // rewrite bodies before the rewriter pass
  | "block:requests"          // veto requests
  | "storage:site"            // per-site keyed storage
  | "spoof:configure";        // change fingerprint profile per-site

export type PluginHooks = {
  onRequest(ctx: RequestContext): RequestVerdict | Promise<RequestVerdict>;
  onResponseHeaders(ctx: ResponseContext): HeaderEdit | Promise<HeaderEdit>;
  onResponseStream(ctx: StreamContext): TransformStream | null;
  onNavigate(ctx: NavigateContext): void;
  onCaptcha(ctx: CaptchaContext): CaptchaPolicy;
};
```

Rules:
- onRequest/onResponseHeaders see metadata, not raw bodies, unless
  modify:responses was granted. Bodies are streams; plugins return a
  TransformStream, never a buffered string.
- A plugin crash is contained: the hook call is wrapped, an exception
  disables that hook for the page load and logs to the technical ring,
  never takes the page down.
- Order: plugins run in registration order; block verdicts short-circuit.
- Ad/tracker stripping (phase 3) ships as the FIRST plugin using this API,
  not as engine code. It must eat its own dogfood.

## 2. Devtools hooks

Two tiers, in this order:

Tier 1, network inspector: the SW keeps a per-page-load ring of request
records (method, decoded target URL, wisp stream id, status, timing quartiles
TTFB/TTLB/done, bytes in/out, plugin verdicts). The devtools page
(app/devtools.html) opens a MessageChannel to the SW and streams the ring.
This is priority: it is also the debugging tool for everything else here.

Tier 2, CDP-subset DOM inspector: an injected content bridge
(postMessage relay, never direct DOM access from the devtools page) that
supports, at most: DOM tree snapshot, element highlight, computed styles,
console capture, storage view. Full CDP is out of scope; the bridge speaks
a tiny JSON schema of our own.

Both tiers respect permissions: an inspector that is not granted
observe:requests shows nothing. Devtools are disabled entirely when the
user is in a "strict" privacy mode.

## 3. Spoofing (fingerprint impersonation)

Location: the wisp server (Rust), never the SW. The SW cannot terminate
TLS, so fingerprint control is upstream by definition.

- Profile model: a FingerprintProfile names (client-hello shape,
  ALPN set, HTTP/2 SETTINGS frame + pseudo-header order, header order and
  casing, sec-ch-ua client hint set). Profiles for the big three engines
  ship built-in and are DATA (json), not code.
- Enforcement: the wisp server applies the profile at connection pool
  creation. Per-site overrides come from siteconfig (app/public/siteconfig.json)
  or from a plugin with spoof:configure.
- Hard rule: JA3/JA4 and HTTP/2 fingerprint must come from the SAME
  profile object so the TLS and H2 layers never disagree. A mismatched
  pair is a bigger tell than an honest Go/Rust client hello.
- Client-side JS surface spoofing (navigator, canvas, WebGL noise) is a
  bootstrap concern and stays in the existing fingerprint docs; it is
  explicitly SECOND to transport-layer honesty. Spoofing JS surfaces while
  the transport screams "proxy" is worse than not spoofing at all.

## 4. Captcha detection (not bypass)

The repo non-negotiable stands: NO automated solving, NO interstitial
bypass, no Google login flows. What we ship instead:

- The rewriter tags responses that match known interstitial markers
  (cf-chl, recaptcha api loads as the only content, hcaptcha iframe,
  HTTP 403/429 with challenge bodies) as a CaptchaState on the page
  record: { kind: "cloudflare" | "recaptcha" | "hcaptcha" | "unknown",
  detectedAt, bodySnapshot (truncated) }.
- The engine adapter surfaces CaptchaState to the embedder. LobsterBrowse
  renders a real "this site wants a human" page with the proxied
  challenge visible and interactive INSIDE the proxy frame, because a
  challenge solved by the real user inside the session is legitimate.
- onCaptcha plugin hook lets plugins change the policy: block the page
  load, retry later, or annotate. It cannot auto-solve. The hook type
  has no "solve" verb on purpose.
- Telemetry: the compat suite records captcha incidence per site so the
  scoreboard shows which sites are effectively unusable, which is the
  honest signal, and which fingerprint profiles correlate with fewer
  challenges (that is the spoofing feedback loop).

## Build order

1. Network inspector ring + devtools streaming (it debugs the rest).
2. Plugin host + permissions + ad-strip as plugin zero.
3. Fingerprint profiles as data + wisp server enforcement.
4. Captcha detection + adapter state + embedder UI.
5. DOM bridge inspector (tier 2) last, it is the least load-bearing.
