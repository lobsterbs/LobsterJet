/* Zeolite extension subsystem: the content-script bridge.

   Served at /zl-cs/<id>/__bridge.js with a per-request config embedded
   ahead of this source. The bridge:

   - builds the browser.* API object for the content-script context
     (runtime.id/getURL/sendMessage, storage.local) backed by a
     MessageChannel to the service worker, which verifies the sender
     page actually matches the extension's declared content_scripts;
   - loads the declared js files and executes each in a Function scope
     with only (browser, chrome) exposed — the page cannot reach the
     API object, and the scripts cannot reach the engine global scope
     (documented limitation: this is isolation-in-one-world, not a
     real Firefox isolated world, which needs renderer support);
   - appends the declared css files as <link> elements at start.

   run_at is honored: document_start runs immediately (the bridge is
   injected into <head> by the rewriter), document_end waits for
   DOMContentLoaded, document_idle waits for load + idle. */

export const BRIDGE_SOURCE = `(function () {
  "use strict";
  var cfg = ZL_CS_CFG;
  var origin = location.origin;
  function chan(req) {
    return new Promise(function (resolve, reject) {
      var ctl = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!ctl) {
        reject(new Error("zeolite: page not controlled by the engine service worker"));
        return;
      }
      var mc = new MessageChannel();
      var t = setTimeout(function () {
        reject(new Error("zeolite: extension message timed out"));
      }, 30000);
      mc.port1.onmessage = function (ev) {
        clearTimeout(t);
        var d = ev.data || {};
        if (d.ok) resolve(d.response);
        else reject(new Error(d.error || "zeolite: extension messaging failed"));
      };
      ctl.postMessage({ type: "zl:ext", extId: cfg.ext, msg: req }, [mc.port2]);
    });
  }
  function storageArea(name) {
    return {
      get: function (keys) { return chan({ __zlStorage: name, op: "get", keys: keys }); },
      set: function (items) { return chan({ __zlStorage: name, op: "set", items: items }); },
      remove: function (keys) { return chan({ __zlStorage: name, op: "remove", keys: keys }); },
      clear: function () { return chan({ __zlStorage: name, op: "clear" }); },
    };
  }
  function apiObject() {
    return {
      runtime: {
        id: cfg.ext,
        getURL: function (p) {
          return "/zl-ext/" + cfg.ext + (p.charAt(0) === "/" ? p : "/" + p);
        },
        sendMessage: function (m) { return chan(m); },
        onMessage: {
          addListener: function () {
            throw new Error("zeolite: runtime.onMessage in content scripts is not supported yet");
          },
          removeListener: function () {},
          hasListener: function () { return false; },
        },
        connect: function () {
          throw new Error("zeolite: runtime.connect from content scripts is not supported yet");
        },
      },
      storage: { local: storageArea("local") },
    };
  }
  function loadCss(href) {
    var l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = origin + href;
    (document.head || document.documentElement).appendChild(l);
  }
  function runScripts(urls, i) {
    if (i >= urls.length) return;
    fetch(origin + urls[i], { credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("content script fetch failed: " + urls[i]);
        return r.text();
      })
      .then(function (code) {
        try {
          var browser = apiObject();
          new Function("browser", "chrome", '"use strict";\n' + code)(browser, browser);
        } catch (e) {
          console.error("[zeolite cs " + cfg.ext + "]", e);
        }
        runScripts(urls, i + 1);
      })
      .catch(function (e) {
        console.error("[zeolite cs " + cfg.ext + "]", e);
        runScripts(urls, i + 1);
      });
  }
  function start() {
    for (var i = 0; i < (cfg.css || []).length; i++) loadCss(cfg.css[i]);
    var js = cfg.js || [];
    if (cfg.runAt === "document_start") {
      runScripts(js, 0);
      return;
    }
    if (cfg.runAt === "document_end") {
      if (document.readyState !== "loading") runScripts(js, 0);
      else document.addEventListener("DOMContentLoaded", function () { runScripts(js, 0); });
      return;
    }
    var idle = window.requestIdleCallback || function (f) { setTimeout(f, 1); };
    if (document.readyState === "complete") idle(function () { runScripts(js, 0); });
    else window.addEventListener("load", function () { idle(function () { runScripts(js, 0); }); });
  }
  start();
})();
`;
