(() => {
  "use strict";

  // Optional visible diagnostic for the WordPress copy/paste test.
  const status = document.getElementById("ctsg-bridge-status");
  const report = (text) => { if (status) status.textContent = text; };
  report("Bridge script running; waiting for iframe communication.");
  // This script MUST execute in the WordPress parent document.
  const frame = document.getElementById("ctsg-site");
  if (!frame) {
    report('Bridge script running, but no iframe with id="ctsg-site" was found.');
    return;
  }
  const childOrigin = new URL(frame.src, location.href).origin;
  const channel = "ctsg-navigation-v1";
  const validRoute = (route) => typeof route === "string" && route.length <= 200
    && /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(route);
  const readRoute = () => validRoute(location.hash.slice(1)) ? location.hash.slice(1) : "/";

  function sendState() {
    if (!validRoute(location.hash.slice(1))) history.replaceState(null, "", "#/");
    frame.contentWindow.postMessage({
      channel, type: "state", route: readRoute(), url: location.href,
    }, childOrigin);
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== frame.contentWindow || event.origin !== childOrigin
      || !message || message.channel !== channel) return;
    if (message.type === "ready") {
      report("Iframe detected. Click a link inside it to test URL synchronization.");
      sendState();
    } else if (message.type === "navigate" && validRoute(message.route)) {
      if (location.hash !== `#${message.route}`) history.pushState(null, "", `#${message.route}`);
      sendState();
      report(`URL synchronization active: ${message.route}`);
    }
  });

  // Back/Forward, hand-edited hashes, and child reloads all use the parent route.
  window.addEventListener("popstate", sendState);
  window.addEventListener("hashchange", sendState);
  frame.addEventListener("load", sendState);
  // Also supports loading this script after the iframe is already ready.
  sendState();
})();
