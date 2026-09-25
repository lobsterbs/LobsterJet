/* Exercises runtime.id / getManifest / getURL against the Zeolite API. */
console.log("hello: id=" + browser.runtime.id);
console.log("hello: name=" + browser.runtime.getManifest().name);
console.log("hello: url=" + browser.runtime.getURL("background.js"));
