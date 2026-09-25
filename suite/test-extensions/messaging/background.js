browser.runtime.onMessage.addListener((msg) => {
  console.log("messaging bg got: " + JSON.stringify(msg));
  return { pong: true };
});
