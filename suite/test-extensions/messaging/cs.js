browser.runtime.sendMessage({ ping: 1 }).then(
  (r) => console.log("messaging cs reply: " + JSON.stringify(r)),
  (e) => console.log("messaging cs error: " + e)
);
