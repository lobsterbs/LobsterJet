browser.storage.local.set({ fixture: "value" }).then(() =>
  browser.storage.local.get("fixture")
).then((got) => console.log("storage: " + JSON.stringify(got)));
