# Zeolite

**Current release: 1.0 Nitride** (see docs/versioning.md)

Interception-based web proxy engine. Service worker on the engine origin
intercepts every request, a Rust/WASM streaming rewriter rewrites responses,
and all transport goes over Wisp v2.1.

Standalone repository, spun out of the LobsterBrowse monorepo (formerly
under the name LobsterJet), but it does not touch LobsterBrowse source:
it deploys as its own service (the service worker must own its origin)
and is embedded via `?url=<target>`.

## Layout

```
crates/
    rewriter/          Rust/WASM streaming HTML/CSS/JS-literal rewriter
                       (package: zeolite-rewriter)
    wisp-wasm/         wasm-bindgen wrapper over wisp-core (package:
                       zeolite-wisp)
    zeolite-server/    standalone wisp server + static host (small VPS,
                       ARM OK)
  app/                 static frontend: SW, runtime bootstrap, embed
                       client, extension compatibility runtime,
                       diagnostics
  suite/               compat probes -> JSON + Markdown scoreboard
  docs/                roadmap, versioning, adapter contract
```

## Non-negotiables

- ONE transport: Wisp v2.1. Reused from LobsterBrowse as a library via git
  dependencies on the LobsterBrowse repository (`wisp-core`,
  `wisp-extensions`; declared in the root `Cargo.toml` workspace table).
  Never reimplemented here. Protocol version pinned at 2.1
  (`wisp-core::handshake` sends major 2 minor 1).
- Streaming always: the rewriter emits while it parses; nothing buffers a
  full document. Time-to-first-paint is the primary metric.
- Hybrid rewriting: static surface (HTML attributes, CSS url(), JS string
  literals) rewritten in emit; behavior (fetch/XHR/WebSocket/storage/
  history/Worker) patched at runtime by a bootstrap under 5 KB (minified).
- No headless browser anything. No Google login / Cloudflare interstitial
  bypass, ever. Out of scope by architecture.

## Extension compatibility (Gecko/WebExtension)

The service worker hosts a WebExtension compatibility runtime so Firefox
and Chrome extensions can run, unmodified, inside proxied pages:

- Manifest v2 and v3 (manifest parsing, permission grants, install flow).
- Background scripts (event page semantics: `onInstalled` on first boot,
  `onStartup` on later boots) with a proxied `self`.
- Content scripts declared in `content_scripts`, with match-pattern
  verification of the real sender host, `run_at` honored, and CSS files.
- API surface: `runtime` (messaging, connect, getURL), `storage`
  (local/sync/session, isolated per extension), `tabs` (bridged to the
  embedding UI's real tab model), `scripting` (declarative host-gated
  injection via a page-side listener), `webNavigation`, `contextMenus`,
  `downloads`, `permissions` (optional grants), and the
  `browser.`/`chrome.` dual namespace.
- Web-accessible resources served under `/zl-ext/`; content-script
  bridge under `/zl-cs/`. Pages can only fetch files the extension
  declared web accessible.

Limits are documented honestly in the compat surface (see
`app/src/extensions/compat.ts`): content scripts run in the page's JS
context rather than an isolated world, and APIs outside the list above
are reported as unavailable rather than faked.

## Diagnostics

Structured, bounded (512 events / 256 traces) diagnostic ring with
categories (TRANSPORT, UPSTREAM, REWRITE, ...), severities, lifecycle
stages (REQUEST_INTERCEPTED ... REWRITE_FAILED), and cause
classifications that never guess. Every proxied request gets a trace id
joined into the network log, and the devtools polls deltas:

- `zl:getNetLog` — request log entries (method, original + proxied URL,
  status, timing, size, resource type classification from
  sec-fetch-dest + content-type, rewrite status, plugin verdicts).
- `zl:getDiag` — diagnostic events since a cursor, same delta protocol.

Secrets (authorization headers, cookie values, bearer tokens) are
redacted before anything enters the ring.

## HTTP over Wisp (Phase 1 decision)

TLS cannot terminate in the service worker itself, so proxied http(s) goes
through a libcurl wasm transport (BareMux-compatible) speaking to the wisp
server. This is a transport choice, not a compat layer; it keeps the SW
small and the single-transport rule intact. WebSocket upgrade traffic does
not need TLS in the SW: the runtime bootstrap implements the WebSocket API
over a raw wisp TCP stream.

## Dev

```
# rewriter + wisp wasm (requires wasm32-unknown-unknown target)
cargo build -p zeolite-rewriter -p zeolite-wisp --target wasm32-unknown-unknown --release
wasm-bindgen glue via app build (npm run build in app/)

# extension subsystem unit tests
cd app && npx vitest run

# standalone server (also serves the built app statically)
cargo run -p zeolite-server -- --port 6002 --static ../app/dist

# compat suite against a running engine
node suite/probe.mjs --base http://localhost:6002
```

## Roadmap

The feature program (interception API, rules engine, WebSocket, virtual
origins and cookies, storage virtualization, worker/SW virtualization,
downloads, session export, fingerprinting resistance, compat suite with
scoreboard, recording/replay) is planned, versioned and tracked in
docs/roadmap.md. One phase per release, each phase green in CI before the
next starts. The extension compatibility runtime and the diagnostics
foundation are complete; deep devtools integration (failure chains,
storage inspector, extension telemetry joins) is in progress.
