# AGENTS.md — Zeolite

Guidance for AI agents (and humans) working on this repository. Read this before changing anything.

## What this is

Zeolite is a proxy engine: a Rust workspace that fetches upstream pages over the Wisp protocol and rewrites them (HTML attributes, CSS url(), srcset, inline styles) so every navigation and subresource flows through engine-local routes. The rewriter runs compiled to WASM inside a service worker (`app/src/sw.ts` build), so page rewriting happens client-side; `zeolite-server` is the Rust side that terminates Wisp sessions.

Do not name the project this engine is derived from anywhere in code, commits, or docs.

## Layout

- `crates/rewriter` — the HTML/CSS rewriter (Rust -> WASM via `crates/wisp-wasm`).
- `crates/wisp-core` — Wisp v2.1 protocol: TCP with credit windows, UDP relay, limits.
- `crates/wisp-extensions` — auth (password, Ed25519 key, MOTD), lifecycle, static-file guard.
- `crates/zeolite-server` — session termination, routing, SSRF protection.
- `app/src/` — the service worker (`sw.ts`), rewriter glue, `diag.ts` diagnostics, `codec.ts` route encode/decode.
- `suite/` — integration/test extensions.
- `docs/` — design docs. `docs/plugins.md` and `docs/engine-adapter.md` describe the interception surface.

## CI gates (read this twice)

The fmt/clippy/test gates were once silently vacuous: `dtolnay/rust-toolchain` sets `CARGO_TERM_COLOR=always`, so every error line starts with an ANSI escape and a grep for `^(error|warning)` never matched. Clippy runs with `-D warnings`; the color env must be cleared (`CARGO_TERM_COLOR= never`) on clippy and test steps, and the step logs must print the tail of the output files. If you touch `.github/workflows/`, keep both properties.

The wasm job builds the SW bundle. Every green main push publishes the built bundle to the force-pushed `dist` branch. Requirements learned the hard way:

- `GITHUB_TOKEN` needs `permissions: contents: write` at the workflow level (default is read-only).
- The publish must run from a FRESH git repo in /tmp (an in-place checkout commits build junk: wasm in app/src, .out logs).
- libcurl (`@mercuryworkshop/libcurl-transport`) is AGPL: it is npm-installed at deploy time and must NEVER be committed to the dist branch.

LobsterBrowse consumes the `dist` branch tarball in its Docker build and serves it under `/zlsw/` with `Service-Worker-Allowed: /`. A broken dist publish breaks LobsterBrowse's deploy, not just this repo.

## Rewriter invariants

- Attribute scanning must not consume bytes past the closing quote; whitespace between attributes must be preserved (past bugs: `<imgsrc=`, lost `>`).
- Raw script/style blocks are only rewritten when the tag-tracking state is intact; blocked script elements swallow their inline content.
- Scheme detection uses RFC 3986 `is_scheme`, not ad-hoc prefix checks; empty-origin prefixes must not match every URL.
- The worker's fetch handler passes through every non-engine path (`isEnginePath`, `/wisp/`, cross-origin). Extension asset routes (`/zl-ext/`, `/zl-cs/`) are served from the extension store in IndexedDB with web_accessible_resources globs enforced per 32-hex extension id.

## Server invariants

- `check_auth` key requirement follows the shared server key config, not whether a KeyAuth instance happened to parse (a past hole let keyless clients in when a server key was set).
- Destination policy resolves DNS first and validates every resolved address (SSRF / DNS-rebinding).
- UDP packet counters are bidirectional.

## Diagnostics

`app/src/diag.ts` owns the DiagEvent ring (512) and trace index (256); every fetch gets a traceId and stage events (REQUEST_INTERCEPTED, UPSTREAM_REQUEST/RESPONSE, REWRITE_STARTED/COMPLETED/FAILED, transport failures). Control-plane messages use `zl:` prefixes over MessageChannel ports; unknown messages must answer honestly ("unknown message"), never silently.

## Honesty norms

- Do not claim a feature works without a CI gate or test that proves it.
- Known gaps get written down (in commits, docs, or the companion AGENTS.md in LobsterBrowse), not papered over.
- rustfmt diffs must be applied exactly as CI prints them.
