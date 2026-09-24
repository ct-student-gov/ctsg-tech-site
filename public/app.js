(() => {
  "use strict";

  const channel = "ctsg-navigation-v1";
  const allowedParents = new Set([
    "https://ctsg.tech.cornell.edu",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
  ]);
  const embedded = window.parent !== window;
  let parentOrigin = null;
  let currentRoute = null;
  const content = document.getElementById("content");
  const validRoute = (route) => typeof route === "string" && route.length <= 200
    && /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(route);
  const readRoute = () => validRoute(location.hash.slice(1)) ? location.hash.slice(1) : "/";

  const pages = new Map([
    ["/", ["About CTSG", "Placeholder for CTSG’s mission and introduction."]],
    ["/members", ["Members", "Placeholder for the executive board and master’s program representatives."]],
    ["/events", ["Student Events", "Placeholder for student events and Club Fair content."]],
    ["/clubs", ["Clubs", "Placeholder for a future clubs directory; this is a proposed page."]],
    ["/clubs/example", ["Example Club", "Test-only club detail page. This is not an actual student organization."]],
    ["/past-members", ["Past Members", "Placeholder for previous CTSG rosters."]],
    ["/by-laws", ["CTSG By-Laws", "Placeholder for governance documents."]],
  ]);

  function render(route, focus = false) {
    const [title, description] = pages.get(route) || ["Page not found", "This route does not have a placeholder page."];
    const heading = document.createElement("h1");
    heading.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.textContent = description;
    content.replaceChildren(heading, paragraph);
    if (route === "/clubs") {
      const link = document.createElement("a");
      link.href = "#/clubs/example";
      link.textContent = "Example Club";
      content.append(link);
    }
    document.title = `${title} | CTSG navigation test`;
    document.getElementById("route").textContent = route;
    document.getElementById("child-url").textContent = location.href;
    document.getElementById("direct-link").href = location.href;
    document.getElementById("mode").textContent = parentOrigin
      ? "Embedded — parent URL sync connected"
      : embedded ? "Embedded — no parent bridge connected; navigation stays inside iframe"
        : "Standalone — URL and history belong to this page";
    for (const link of document.querySelectorAll("nav a")) {
      if (link.hash === `#${route}`) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    currentRoute = route;
    if (focus) content.focus();
  }

  function post(message) {
    window.parent.postMessage({ channel, ...message }, parentOrigin);
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!embedded || event.source !== window.parent || !allowedParents.has(event.origin)
      || !message || message.channel !== channel || message.type !== "state"
      || !validRoute(message.route)) return;
    parentOrigin = event.origin;
    // The parent owns history in bridge mode. Never add a second child entry.
    history.replaceState(null, "", `#${message.route}`);
    document.getElementById("parent-url").textContent = typeof message.url === "string" ? message.url : "Connected";
    render(message.route, currentRoute !== message.route);
  });

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (!link || !link.getAttribute("href")?.startsWith("#/") || event.defaultPrevented
      || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      || link.target || link.hasAttribute("download")) return;
    const route = link.hash.slice(1);
    if (!validRoute(route)) return;
    event.preventDefault();
    if (parentOrigin) post({ type: "navigate", route });
    else {
      if (readRoute() !== route) history.pushState(null, "", `#${route}`);
      render(route, true);
    }
  });

  function onHistoryChange() {
    if (parentOrigin) post({ type: "ready" });
    else render(readRoute());
  }
  window.addEventListener("popstate", onHistoryChange);
  window.addEventListener("hashchange", onHistoryChange);
  history.replaceState(null, "", `#${readRoute()}`);
  render(readRoute());
  if (embedded) {
    // If referrers are suppressed, the bridge's load/init message starts the handshake.
    let referrerOrigin;
    try { referrerOrigin = new URL(document.referrer).origin; } catch { /* No referrer. */ }
    if (allowedParents.has(referrerOrigin)) {
      window.parent.postMessage({ channel, type: "ready" }, referrerOrigin);
    }
  }
})();
