/* Zeolite extension subsystem: browser.scripting.

   executeScript/insertCSS read the files out of the extension's own
   package (server side) and push the code to the target page over
   the SW->page channel. The page-side listener (LISTENER_SOURCE,
   served at /zl-cs/__scripting.js and injected by the rewriter
   whenever any enabled extension holds the scripting permission)
   verifies it is the intended target page, then runs the code in a
   Function scope with the same content-script API surface.

   Permission model: "scripting" plus a host permission for the
   target tab's URL, enforced HERE. The page listener trusts only
   the service worker (ev.source === controller) but cannot
   re-verify host permissions, so this check is the boundary. */

import { extensions } from "./manager";
import { TABS } from "./tabs";
import { hostPatternsMatch } from "./permissions";
import type { ExtensionId, ExtensionRecord } from "./types";

export interface ScriptingInjection {
  target: { tabId: number };
  files?: string[];
}

export interface ScriptingMessage {
  type: "zl:scripting";
  extId: ExtensionId;
  dest: string;
  js: string[];
  css: string[];
}

export class ScriptingHost {
  private dispatch: ((msg: ScriptingMessage) => void) | null = null;

  setDispatch(fn: ((msg: ScriptingMessage) => void) | null): void {
    this.dispatch = fn;
  }

  private check(ext: ExtensionRecord, tabId: number | undefined): string {
    if (tabId === undefined) {
      throw new Error("zeolite: scripting requires a target tabId");
    }
    if (!ext.permissions.includes("scripting")) {
      throw new Error("zeolite: permission 'scripting' not granted to this extension");
    }
    const tab = TABS.get(tabId);
    if (!tab) throw new Error("Invalid tab ID: " + tabId);
    if (!hostPatternsMatch(ext.hostPermissions, tab.url)) {
      throw new Error("zeolite: host permission for '" + tab.url + "' not granted to this extension");
    }
    return tab.url;
  }

  private async readFiles(extId: ExtensionId, files: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const f of files) {
      const path = f.startsWith("/") ? f : "/" + f;
      const bytes = await extensions.getResource(extId, path, { fromWeb: false });
      if (!bytes) throw new Error("file not found in extension package: " + f);
      out.push(new TextDecoder().decode(bytes));
    }
    return out;
  }

  async executeScript(ext: ExtensionRecord, inj: ScriptingInjection): Promise<void> {
    const dest = this.check(ext, inj?.target?.tabId);
    const js = await this.readFiles(ext.id, inj.files ?? []);
    this.dispatch?.({ type: "zl:scripting", extId: ext.id, dest, js, css: [] });
  }

  async insertCSS(ext: ExtensionRecord, inj: ScriptingInjection): Promise<void> {
    const dest = this.check(ext, inj?.target?.tabId);
    const css = await this.readFiles(ext.id, inj.files ?? []);
    this.dispatch?.({ type: "zl:scripting", extId: ext.id, dest, js: [], css });
  }
}

export const SCRIPTING = new ScriptingHost();

/* Page-side listener: injected once per document when any enabled
   extension holds the scripting permission. It accepts messages
   only from the controlling service worker and only for its own
   page destination. */
export const LISTENER_SOURCE = [
  "(function () {",
  "  \"use strict\";",
  "  var ctl = navigator.serviceWorker && navigator.serviceWorker.controller;",
  "  if (!ctl) return;",
  "  function chan(ext, req) {",
  "    return new Promise(function (resolve, reject) {",
  "      var mc = new MessageChannel();",
  "      var t = setTimeout(function () {",
  "        reject(new Error(\"zeolite: extension message timed out\"));",
  "      }, 30000);",
  "      mc.port1.onmessage = function (ev) {",
  "        clearTimeout(t);",
  "        var d = ev.data || {};",
  "        if (d.ok) resolve(d.response);",
  "        else reject(new Error(d.error || \"zeolite: extension messaging failed\"));",
  "      };",
  "      ctl.postMessage({ type: \"zl:ext\", extId: ext, msg: req }, [mc.port2]);",
  "    });",
  "  }",
  "  function api(ext) {",
  "    return {",
  "      runtime: {",
  "        id: ext,",
  "        getURL: function (p) {",
  "          return \"/zl-ext/\" + ext + (p.charAt(0) === \"/\" ? p : \"/\" + p);",
  "        },",
  "        sendMessage: function (m) { return chan(ext, m); },",
  "        onMessage: {",
  "          addListener: function () {",
  "            throw new Error(\"zeolite: runtime.onMessage in injected scripts is not supported yet\");",
  "          },",
  "          removeListener: function () {},",
  "          hasListener: function () { return false; },",
  "        },",
  "      },",
  "      storage: {",
  "        local: {",
  "          get: function (k) { return chan(ext, { __zlStorage: \"local\", op: \"get\", keys: k }); },",
  "          set: function (i) { return chan(ext, { __zlStorage: \"local\", op: \"set\", items: i }); },",
  "          remove: function (k) { return chan(ext, { __zlStorage: \"local\", op: \"remove\", keys: k }); },",
  "          clear: function () { return chan(ext, { __zlStorage: \"local\", op: \"clear\" }); },",
  "        },",
  "      },",
  "    };",
  "  }",
  "  navigator.serviceWorker.addEventListener(\"message\", function (ev) {",
  "    if (ev.source !== ctl) return;",
  "    var m = ev.data;",
  "    if (!m || m.type !== \"zl:scripting\") return;",
  "    var dest = (window.__ZL && window.__ZL.dest) || document.baseURI;",
  "    if (m.dest !== dest) return;",
  "    var browser = api(m.extId);",
  "    for (var i = 0; i < (m.css || []).length; i++) {",
  "      var s = document.createElement(\"style\");",
  "      s.textContent = m.css[i];",
  "      (document.head || document.documentElement).appendChild(s);",
  "    }",
  "    var js = m.js || [];",
  "    for (var j = 0; j < js.length; j++) {",
  "      try {",
  "        new Function(\"browser\", \"chrome\", '\"use strict\";\\n' + js[j])(browser, browser);",
  "      } catch (e) {",
  "        console.error(\"[zeolite scripting \" + m.extId + \"]\", e);",
  "      }",
  "    }",
  "  });",
  "})();",
].join("\n");
