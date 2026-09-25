# Zeolite

**Current release: 1.0 Nitride** (see docs/versioning.md)

Interception-based web proxy engine. Service worker on the engine origin
intercepts every request, a Rust/WASM streaming rewriter rewrites responses,
and all transport goes over Wisp v2.1.

Standalone repository, spun out of the LobsterBrowse monorepo (formerly
under the name LobsterJet), but it does not touch LobsterBrowse source:
like Scramjet, it deploys as its own service (the service worker must own
its origin) and is embedded via `?url=<target>`.

## Layout

```
crates/
    rewriter/          Rust/WASM streaming HTML/CSS/JS-literal rewriter
                       (package: zeolite-rewriter)
    wisp-wasm/         wasm-bindgen wrapper over wisp-core (package:
                       zeolite-wisp)
    zeolite-server/    standalone wisp server + static host (small VPS,
                       ARM OK)
  app/                 static frontend: SW, runtime bootstrap, embed client
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

## Roadmap

The feature program (interception API, rules engine, WebSocket, virtual
origins and cookies, storage virtualization, worker/SW virtualization,
downloads, session export, fingerprinting resistance, compat suite with
scoreboard, recording/replay) is planned, versioned and tracked in
docs/roadmap.md. One phase per release, each phase green in CI before the
next starts.

## HTTP over Wisp (Phase 1 decision)

TLS cannot terminate in the service worker itself, so proxied http(s) goes
through the same proven path Scramjet uses: a libcurl wasm transport
(BareMux-compatible) speaking to the wisp server. This is a transport
choice, not a compat layer; it keeps the SW small and the single-transport
rule intact. WebSocket upgrade traffic does not need TLS in the SW: the
runtime bootstrap implements the WebSocket API over a raw wisp TCP stream.

## Dev

```
# rewriter + wisp wasm (requires wasm32-unknown-unknown target)
cargo build -p zeolite-rewriter -p zeolite-wisp --target wasm32-unknown-unknown --release
wasm-bindgen glue via app build (npm run build in app/)

# standalone server (also serves the built app statically)
cargo run -p zeolite-server -- --port 6002 --static ../app/dist

# compat suite against a running engine
node suite/probe.mjs --base http://localhost:6002
```
