/* Zeolite extension subsystem: public surface (Phase 1).

   Consumers (LobsterBrowse, tests) import from here only — never the
   internals. The singleton manager owns lifecycle and persistence;
   compatibility is queryable through the matrix. */

export { extensions, ExtensionManager } from "./manager";
export type { InstallResult, LifecycleListener } from "./manager";
export { parseManifest } from "./manifest";
export type { ManifestDiagnostics, ParsedExtension } from "./manifest";
export { ExtensionManager as Manager } from "./manager";
export { COMPAT, compatReport } from "./compat";
export type { CompatEntry, CompatLevel } from "./compat";
export type { ExtensionRecord, ExtensionId, ExtensionState } from "./types";
export { buildApi } from "./runtime";
export type { ApiDeps } from "./runtime";
export { ExtensionMessenger } from "./messaging";
export { ExtensionStorageArea } from "./storage";
export { readZip, locateManifest } from "./package";
export { resolveContentScripts, contentScriptMatches, globToRegExp } from "./content-scripts";
export { EXT_SCHEME, parseExtensionUrl, extensionUrl, normalizeExtensionPath } from "./origin";
export { MESSENGER, getExtensionContext } from "./context";
export { bootEnabled, bootExtension } from "./background";
export {
  serveExtensionAsset,
  parseServePath,
  EXT_ROUTE,
  CS_ROUTE,
} from "./serve";
export { TABS, TabRegistry, tabView, changeView } from "./tabs";
export type { UiTab, TabsEvent, TabsOp, TabsListener, TabChangeInfo } from "./tabs";
