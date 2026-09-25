/* Phase 3 probe: webRequest is in the compat matrix as unsupported.
   Installing this fixture must succeed; the API calls must fail loudly. */
try {
  browser.webRequest.onBeforeRequest.addListener(() => {}, { urls: ["<all_urls>"] });
} catch (e) {
  console.log("webrequest-blocker: expected failure: " + e);
}
