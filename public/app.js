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
  const header = document.querySelector(".site-header");
  const headerSpace = document.querySelector(".site-header-space");
  // Reserve the header's full height even while the fixed overlay is hidden.
  // Only resizing the header changes this space; scrolling never does.
  const reserveHeaderSpace = () => {
    headerSpace.style.height = `${header.offsetHeight}px`;
  };
  reserveHeaderSpace();
  header.classList.add("site-header--floating");
  new ResizeObserver(reserveHeaderSpace).observe(header);
  let previousScroll = Math.max(0, window.scrollY);

  window.addEventListener("scroll", () => {
    // Clamp elastic overscroll and ignore tiny movements to avoid flickering.
    const maximumScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const scroll = Math.min(maximumScroll, Math.max(0, window.scrollY));
    if (scroll <= header.offsetHeight) {
      header.classList.remove("site-header--hidden");
    } else if (Math.abs(scroll - previousScroll) >= 6) {
      header.classList.toggle("site-header--hidden", scroll > previousScroll);
    } else {
      return;
    }
    previousScroll = scroll;
  }, { passive: true });

  header.addEventListener("focusin", () => header.classList.remove("site-header--hidden"));
  const validRoute = (route) => typeof route === "string" && route.length <= 200
    && /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(route);
  const readRoute = () => validRoute(location.hash.slice(1)) ? location.hash.slice(1) : "/";

  const pages = new Map([
    ["/", ["About CTSG", "We are the Cornell Tech Student Government. We aim to serve Cornell Tech by giving master’s students a voice, representing student opinions, and maintaining tradition to enrich the overall quality of student life. We give student interest groups funding, put on events, and serve as the liaison between you and CT administration."]],
    ["/members", ["Your representatives", "The executive board and program representatives."]],
    ["/events", ["Student Events", "Placeholder for student events and Club Fair content."]],
    ["/clubs", ["Clubs", "Placeholder for a future clubs directory; this is a proposed page."]],
    ["/clubs/example", ["Example Club", "Test-only club detail page. This is not an actual student organization."]],
    ["/past-members", ["Past Members", "Placeholder for previous CTSG rosters."]],
    ["/by-laws", ["CTSG By-Laws", "Placeholder for governance documents."]],
  ]);

  function render(route, focus = false) {
    const pageRoute = route;
    const [title, description] = pages.get(pageRoute) || ["Page not found", "This route does not have a placeholder page."];
    const heading = document.createElement("h1");
    heading.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.textContent = description;
    content.classList.toggle("site-content--home", pageRoute === "/");
    if (pageRoute === "/") {
      content.replaceChildren(document.getElementById("home-template").content.cloneNode(true));
    } else {
      content.replaceChildren(heading, paragraph);
    }
    if (pageRoute === "/members") {
      content.append(document.getElementById("members-template").content.cloneNode(true));
    }
    if (route === "/clubs") {
      const link = document.createElement("a");
      link.href = "#/clubs/example";
      link.textContent = "Example Club";
      content.append(link);
    }
    document.title = `${title} | CTSG`;
    for (const link of document.querySelectorAll(".site-nav a")) {
      if (link.hash === `#${pageRoute}`) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    currentRoute = route;
    if (focus) {
      content.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
    header.classList.remove("site-header--hidden");
    previousScroll = Math.max(0, window.scrollY);
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
    render(message.route, currentRoute !== message.route);
  });

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    // Keep the skip link inside the current page without changing its hash route.
    if (link?.classList.contains("skip-link")) {
      event.preventDefault();
      content.focus();
      content.scrollIntoView();
      return;
    }
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
