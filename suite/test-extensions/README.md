# Zeolite test extensions

Tiny fixtures, one per subsystem, exercised by the extension compat
suite. Each installs cleanly through the Phase 1 manager; fixtures for
not-yet-supported APIs (webRequest, MV3 service workers) must install
successfully and fail loudly at call time, never silently.

- hello: background script + runtime basics (MV2)
- popup: browser_action popup page
- content-script: document_idle all-urls script
- storage: storage.local round-trip
- messaging: background <-> content-script sendMessage
- mv3-scripts: Firefox-style MV3 background scripts
- mv3-service-worker: recorded-not-executed MV3 SW background
- options: options_ui page
- webrequest-blocker: Phase 3 probe, expects explicit API failure
- multiframe-content: all_frames document_start script
