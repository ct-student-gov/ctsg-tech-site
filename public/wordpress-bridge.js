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
  const favicon = document.createElement("link");
  favicon.rel = "icon";
  favicon.type = "image/webp";
  favicon.sizes = "96x96";
  favicon.href = new URL("./images/favicon.webp", frame.src).href;
  document.querySelectorAll('link[rel~="icon"]').forEach(icon => icon.remove());
  document.head.append(favicon);
  // Safari paints its edge areas from the outer page, not the iframe's body.
  const colorPreference = window.matchMedia("(prefers-color-scheme: dark)");
  const themeColor = document.createElement("meta");
  themeColor.name = "theme-color";
  document.querySelectorAll('meta[name="theme-color"]').forEach(meta => meta.remove());
  document.head.append(themeColor);
  function syncAppearance() {
    const scheme = colorPreference.matches ? "dark" : "light";
    const background = colorPreference.matches ? "#222" : "#fff";
    for (const element of [document.documentElement, document.body, frame]) {
      element.style.colorScheme = scheme;
      element.style.backgroundColor = background;
    }
    themeColor.content = background;
  }
  syncAppearance();
  colorPreference.addEventListener("change", syncAppearance);
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
    } else if (message.type === "title" && validRoute(message.route)
      && message.route === readRoute() && typeof message.title === "string"
      && message.title.trim() && message.title.length <= 300) {
      document.title = message.title;
    }
  });

  // Back/Forward, hand-edited hashes, and child reloads all use the parent route.
  window.addEventListener("popstate", sendState);
  window.addEventListener("hashchange", sendState);
  frame.addEventListener("load", sendState);
  // Also supports loading this script after the iframe is already ready.
  sendState();
})();
