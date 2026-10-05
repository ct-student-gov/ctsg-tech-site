// Content must still render when a browser blocks the analytics module.
function trackPageView(route, title) {
  void import("./analytics.js")
    .then(analytics => analytics.trackPageView(route, title))
    .catch(() => {});
}

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
  let disposeCalendar = () => {};
  let disposePeople = () => {};
  let blogPromise;
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
  let activePersonDetails = null;
  window.addEventListener("resize", () => activePersonDetails?.dismiss());
  document.addEventListener("click", event => {
    if (activePersonDetails && !activePersonDetails.card.contains(event.target)) activePersonDetails.dismiss();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") activePersonDetails?.dismiss();
  });
  const validRoute = (route) => typeof route === "string" && route.length <= 200
    && /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(route);
  const readRoute = () => validRoute(location.hash.slice(1)) ? location.hash.slice(1) : "/";

  const pages = new Map([
    ["/", "About CTSG"],
    ["/members", "People"],
    ["/events", "Event Calendar"],
    ["/by-laws", "Bylaws"],
  ]);

  const cardMotion = window.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");

  function enableCardMotion(root = content) {
    for (const card of root.querySelectorAll(".home-event-image, .home-portraits, .event-card")) {
      const reset = () => {
        card.classList.remove("card-motion-active");
        card.style.removeProperty("--card-rotate-x");
        card.style.removeProperty("--card-rotate-y");
      };
      card.addEventListener("pointermove", (event) => {
        if (!cardMotion.matches || event.pointerType === "touch") {
          reset();
          return;
        }
        const bounds = card.getBoundingClientRect();
        const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
        const y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1));
        card.style.setProperty("--card-rotate-x", `${-y * 1.5}deg`);
        card.style.setProperty("--card-rotate-y", `${x * 1.5}deg`);
        card.classList.add("card-motion-active");
      });
      card.addEventListener("pointerleave", reset);
      card.addEventListener("pointercancel", reset);
    }
  }

  function addPersonDetails(card, portrait, person, id) {
    const name = `${person.firstName} ${person.lastName}`.trim();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "member-portrait-button";
    button.setAttribute("aria-label", `More about ${name}`);
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", id);
    portrait.replaceWith(button);
    button.append(portrait);
    const nameButton = document.createElement("button");
    nameButton.type = "button";
    nameButton.className = "member-name-button";
    nameButton.textContent = name;
    nameButton.setAttribute("aria-expanded", "false");
    nameButton.setAttribute("aria-controls", id);
    card.querySelector("h4").replaceChildren(nameButton);
    const roleButton = document.createElement("button");
    roleButton.type = "button";
    roleButton.className = "member-role-button";
    roleButton.textContent = person.role;
    roleButton.setAttribute("aria-expanded", "false");
    roleButton.setAttribute("aria-controls", id);
    card.querySelector(".member-identity > p").replaceChildren(roleButton);
    const triggers = [button, nameButton, roleButton];
    let activeTrigger = button;

    // One animated surface surrounds the original card and its extra details.
    const frame = document.createElement("div");
    frame.className = "member-expansion-frame";
    frame.setAttribute("aria-hidden", "true");
    card.prepend(frame);
    card.classList.add("member-card");

    const panel = document.createElement("div");
    panel.id = id;
    panel.className = "member-info";
    panel.tabIndex = -1;
    panel.hidden = true;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-labelledby", `${id}-name`);
    card.querySelector("h4").id = `${id}-name`;
    const inner = document.createElement("div");
    inner.className = "member-info-content";
    const program = document.createElement("p");
    program.textContent = `${person.program ?? "Program TBD"} · ${person.graduationYear ?? "Year TBD"}`;
    if (program.textContent) inner.append(program);
    for (const text of person.biography?.length ? person.biography : ["More information coming soon."]) {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      inner.append(paragraph);
    }
    panel.append(inner);
    card.append(panel);
    let expanded = false;
    let animation = null;
    let frameAnimation = null;
    const identity = card.querySelector(".member-identity");
    const identityElements = [identity];
    let identityAnimations = [];
    const animateHeight = (height, finished) => {
      const from = panel.getBoundingClientRect().height;
      const fromClip = getComputedStyle(panel).clipPath;
      const frameBounds = frame.getBoundingClientRect();
      const frameInset = parseFloat(getComputedStyle(frame).getPropertyValue("--frame-inset"));
      const cardBounds = card.getBoundingClientRect();
      const identityTransforms = identityElements.map(element => getComputedStyle(element).transform);
      animation?.cancel();
      frameAnimation?.cancel();
      identityAnimations.forEach(animation => animation.cancel());
      panel.style.height = `${height}px`;
      const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 260;
      const timing = { duration, easing: "cubic-bezier(.2, .7, .2, 1)" };
      const panelLeft = parseFloat(panel.style.left);
      const identityTarget = `translateX(${expanded ? Math.max(0, panelLeft + panel.offsetWidth - cardBounds.width) : 0}px)`;
      identityAnimations = identityElements.map((element, index) => {
        element.style.transform = identityTarget;
        return element.animate([
          { transform: identityTransforms[index] },
          { transform: identityTarget },
        ], timing);
      });
      const closedClip = `inset(0 ${Math.max(0, panel.offsetWidth + panelLeft - card.offsetWidth)}px 100% ${Math.max(0, -panelLeft)}px)`;
      const targetClip = expanded ? "inset(0 0 0 0)" : closedClip;
      panel.style.clipPath = targetClip;
      const frameTarget = {
        height: `${Math.max(card.offsetHeight, height) + 2 * frameInset}px`,
        width: `${(expanded ? Math.max(card.offsetWidth, panelLeft + panel.offsetWidth) - Math.min(0, panelLeft) : card.offsetWidth) + 2 * frameInset}px`,
        left: `${(expanded ? Math.min(0, panelLeft) : 0) - frameInset}px`,
      };
      Object.assign(frame.style, frameTarget);
      frameAnimation = frame.animate([
        { height: `${frameBounds.height}px`, width: `${frameBounds.width}px`, left: `${frameBounds.left - cardBounds.left}px` },
        frameTarget,
      ], timing);
      animation = panel.animate([
        { height: `${from}px`, clipPath: from === 0 ? closedClip : fromClip },
        { height: `${height}px`, clipPath: targetClip },
      ], timing);
      animation.finished.then(finished, () => {});
    };
    const dismiss = () => {
      if (!expanded) return;
      expanded = false;
      triggers.forEach(trigger => trigger.setAttribute("aria-expanded", "false"));
      if (panel.contains(document.activeElement)) activeTrigger.focus({ preventScroll: true });
      panel.inert = true;
      if (activePersonDetails?.card === card) activePersonDetails = null;
      animateHeight(0, () => {
        panel.hidden = true;
        frame.removeAttribute("style");
        card.classList.remove("member-expanded");
      });
    };
    card.addEventListener("pointerleave", event => {
      if (event.pointerType === "mouse") dismiss();
    });
    card.addEventListener("focusout", event => {
      if (!card.contains(event.relatedTarget)) dismiss();
    });
    const toggleDetails = event => {
      if (expanded) {
        dismiss();
        return;
      }
      activePersonDetails?.dismiss();
      activePersonDetails = { card, dismiss };
      activeTrigger = triggers.find(trigger => trigger.contains(event.target)) ?? button;
      expanded = true;
      triggers.forEach(trigger => trigger.setAttribute("aria-expanded", "true"));
      panel.hidden = false;
      panel.inert = false;
      card.classList.add("member-expanded");
      const anchor = card.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const detailWidth = Math.min(480, viewportWidth - 48);
      // Keep the expanding profile inside the page and reserve its portrait area.
      const stackedLeft = Math.max(24, Math.min(anchor.left + (anchor.width - detailWidth) / 2, viewportWidth - detailWidth - 24));
      panel.style.width = `${detailWidth}px`;
      panel.style.left = `${stackedLeft - anchor.left}px`;
      panel.style.setProperty("--identity-width", `${anchor.width}px`);
      panel.style.setProperty("--identity-height", `${identity.offsetHeight}px`);
      panel.classList.toggle("member-info--stacked", detailWidth - anchor.width - 28 < 180);
      animateHeight(inner.offsetHeight, () => {});
      if (event.detail === 0) panel.focus({ preventScroll: true });
    };
    card.addEventListener("click", event => {
      // Keep the open biography selectable without closing the profile.
      if (panel.contains(event.target)) return;
      toggleDetails(event);
    });
  }

  const memberRoleOrder = [
    "Technical President",
    "Professional President",
    "Treasurer",
    "Student Activities",
    "Communications",
    "External Affairs",
    "Diversity and Inclusion",
    "M.Eng. CS",
    "M.Eng. ECE",
    "M.Eng. ORIE",
    "M.Eng. DSDA",
    "M.S. Connective Media",
    "M.S. Health Tech",
    "M.S. Urban Tech",
    "M.S. Matter Design Computation",
    "MBA",
    "LLM",
  ];
  function memberRoleRank(person) {
    const index = memberRoleOrder.findIndex(role => person.role.startsWith(role));
    return index < 0 ? memberRoleOrder.length : index;
  }

  function fitPeopleNames() {
    for (const title of content.querySelectorAll(".members-gallery h4")) {
      title.style.removeProperty("font-size");
      const style = getComputedStyle(title);
      const available = title.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (available <= 0) continue;
      // Measure the rendered lines after normal wrapping has used every break.
      const range = document.createRange();
      range.selectNodeContents(title.querySelector("button") || title);
      const widestLine = Math.max(0, ...Array.from(range.getClientRects(), rect => rect.width));
      if (widestLine > available) {
        const size = parseFloat(style.fontSize) * available / widestLine;
        title.style.fontSize = `${Math.floor(size * 100) / 100}px`;
      }
    }
  }

  function renderPeople(peopleData) {
    const fragment = document.getElementById("members-template").content.cloneNode(true);
    if (peopleData.banner.src) {
      const photo = document.createElement("img");
      photo.src = peopleData.banner.src;
      photo.alt = peopleData.banner.alt;
      fragment.querySelector(".members-banner").replaceChildren(photo);
    }
    const years = fragment.querySelector(".members-years");
    for (const year of [...peopleData.years].sort((a, b) => b.startYear - a.startYear)) {
      const section = document.createElement("section");
      section.className = "members-year";
      const heading = document.createElement("h2");
      heading.id = `members-${year.startYear}`;
      heading.textContent = `${year.startYear}–${year.startYear + 1}`;
      section.setAttribute("aria-labelledby", heading.id);
      section.append(heading);
      for (const [key, label] of [["executive-board", "Executive Board"], ["representatives", "Representatives"]]) {
        const members = year.members.filter(person => person.section === key).sort((a, b) =>
          memberRoleRank(a) - memberRoleRank(b)
          || (key === "representatives" ? (a.graduationYear ?? Infinity) - (b.graduationYear ?? Infinity) : 0));
        if (!members.length) continue;
        const group = document.createElement("section");
        group.className = "members-group";
        const groupHeading = document.createElement("h3");
        groupHeading.id = `members-${year.startYear}-${key}`;
        groupHeading.textContent = label;
        group.setAttribute("aria-labelledby", groupHeading.id);
        const gallery = document.createElement("ul");
        gallery.className = "members-gallery";
        for (const [index, person] of members.entries()) {
          const card = document.createElement("li");
          const name = `${person.firstName} ${person.lastName}`.trim();
          const portrait = document.createElement("img");
          portrait.src = person.portrait;
          portrait.alt = name === "TBD" ? "" : name;
          portrait.width = 280;
          portrait.height = 280;
          portrait.loading = "lazy";
          portrait.decoding = "async";
          const title = document.createElement("h4");
          title.textContent = name;
          const details = document.createElement("p");
          details.textContent = person.role;
          const identity = document.createElement("div");
          identity.className = "member-identity";
          identity.append(portrait, title, details);
          card.append(identity);
          if (name !== "TBD" && person.biography?.length) addPersonDetails(card, portrait, person, `person-${year.startYear}-${key}-${index}`);
          gallery.append(card);
        }
        group.append(groupHeading, gallery);
        section.append(group);
      }
      years.append(section);
    }
    content.replaceChildren(fragment);
    const directory = content.querySelector(".members-directory");
    let previousWidth = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === previousWidth) return;
      previousWidth = entry.contentRect.width;
      fitPeopleNames();
    });
    observer.observe(directory);
    document.fonts.ready.then(() => {
      if (directory.isConnected) fitPeopleNames();
    });
    disposePeople = () => observer.disconnect();
  }

  function enableProjectToggle() {
    const list = content.querySelector("#home-project-list");
    const button = content.querySelector(".home-projects-toggle");
    if (list.children.length <= 3) return;
    list.setAttribute("data-collapsed", "");
    button.hidden = false;
    button.addEventListener("click", () => {
      const collapsed = list.toggleAttribute("data-collapsed");
      button.setAttribute("aria-expanded", String(!collapsed));
      button.textContent = collapsed ? "Show more" : "Show less";
    });
  }

  function enableEventDetails() {
    for (const button of content.querySelectorAll(".event-card")) {
      const dialog = document.getElementById(button.getAttribute("aria-controls"));
      const gallery = dialog.querySelector(".event-gallery");
      const slides = gallery ? [...gallery.querySelectorAll("figure")] : [];
      let resetGallery = () => {};
      if (slides.length > 1) {
        let activeIndex = 0;
        let loopSlides = [];
        const controls = document.createElement("div");
        controls.className = "event-gallery-controls";
        const previous = document.createElement("button");
        previous.type = "button";
        previous.textContent = "←";
        previous.setAttribute("aria-label", "Previous image");
        const next = document.createElement("button");
        next.type = "button";
        next.textContent = "→";
        next.setAttribute("aria-label", "Next image");
        const position = document.createElement("span");
        position.className = "eyebrow event-gallery-position";
        position.setAttribute("aria-live", "polite");
        position.setAttribute("aria-atomic", "true");
        controls.append(previous, next);
        const frame = document.createElement("div");
        frame.className = "event-gallery-frame";
        gallery.before(frame);
        frame.append(gallery, controls);
        const wrapIndex = index => ((index % slides.length) + slides.length) % slides.length;
        const currentIndex = () => wrapIndex(activeIndex + Math.round(gallery.scrollLeft / (gallery.clientWidth || 1)) - 1);
        const updateGallery = () => {
          const width = gallery.clientWidth;
          if (!width) return;
          const index = currentIndex();
          position.textContent = `${index + 1} / ${slides.length}`;
          const visibleSlide = Math.max(0, Math.min(loopSlides.length - 1, Math.round(gallery.scrollLeft / width)));
          const caption = loopSlides[visibleSlide].querySelector("figcaption");
          if (position.parentElement !== caption) caption.append(position);
        };
        const moveTo = index => {
          activeIndex = wrapIndex(index);
          // Only one neighbouring image is reachable in either direction.
          loopSlides = [-1, 0, 1].map(offset => {
            const clone = slides[wrapIndex(activeIndex + offset)].cloneNode(true);
            if (offset) clone.setAttribute("aria-hidden", "true");
            clone.querySelector("img").loading = "eager";
            return clone;
          });
          gallery.replaceChildren(...loopSlides);
          gallery.scrollTo({ left: gallery.clientWidth, behavior: "instant" });
          updateGallery();
        };
        previous.addEventListener("click", () => moveTo(currentIndex() - 1));
        next.addEventListener("click", () => moveTo(currentIndex() + 1));
        // The browser owns the trackpad gesture. No wheel packets become queued swipes.
        gallery.addEventListener("scroll", updateGallery, { passive: true });
        gallery.addEventListener("scrollend", () => {
          if (!dialog.open || !gallery.clientWidth) return;
          const page = Math.round(gallery.scrollLeft / gallery.clientWidth);
          // Refill neighbours only after scrolling has stopped, preserving the visible image.
          if (page !== 1) moveTo(currentIndex());
        });
        gallery.addEventListener("keydown", event => {
          const target = { ArrowLeft: currentIndex() - 1, ArrowRight: currentIndex() + 1, Home: 0, End: slides.length - 1 }[event.key];
          if (target === undefined) return;
          event.preventDefault();
          moveTo(target);
        });
        resetGallery = () => moveTo(0);
      }
      button.addEventListener("click", () => {
        dialog.showModal();
        dialog.scrollTop = 0;
        resetGallery();
      });
      dialog.addEventListener("click", (event) => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
      });
    }
  }

  async function loadBlog(list) {
    try {
      // Keep one fresh snapshot per page load, without delaying the first screen.
      const [{ renderBlog }, { blogData }] = await (blogPromise ??= Promise.all([
        import("./blog.js?v=notion-descriptions-1"),
        import(`./data/blog.js?updated=${Date.now()}`),
      ]));
      if (!list.isConnected) return;
      renderBlog(list, blogData);
      enableProjectToggle();
      enableEventDetails();
      enableCardMotion(list);
    } catch {
      if (!list.isConnected) return;
      const message = document.createElement("li");
      message.textContent = "Blog posts could not be loaded. Please reload to try again.";
      message.setAttribute("role", "status");
      list.replaceChildren(message);
    }
  }

  async function loadCalendar(root, options) {
    try {
      const { mountCalendar } = await import("./calendar.js?v=break-colors-1");
      if (root.isConnected) disposeCalendar = mountCalendar(root, options);
    } catch {
      if (root.isConnected) root.querySelector(".calendar-status").textContent = "Events could not be loaded. Please reload to try again.";
    }
  }

  async function loadPeople(status) {
    try {
      const { peopleData } = await import("./data/people.js");
      // A slow response must not replace a page the visitor navigated to.
      if (status.isConnected) renderPeople(peopleData);
    } catch {
      if (status.isConnected) status.textContent = "People could not be loaded. Please reload to try again.";
    }
  }

  function render(route, focus = false) {
    activePersonDetails?.dismiss();
    content.querySelectorAll(".event-details[open]").forEach(dialog => dialog.close());
    const pageRoute = route;
    const title = pages.get(pageRoute) || "Page not found";
    content.classList.toggle("site-content--home", pageRoute === "/");
    content.classList.toggle("site-content--members", pageRoute === "/members");
    content.classList.toggle("site-content--governance", pageRoute === "/by-laws");
    content.classList.toggle("site-content--events", pageRoute === "/events");
    disposeCalendar();
    disposeCalendar = () => {};
    disposePeople();
    disposePeople = () => {};
    if (pageRoute === "/") {
      content.replaceChildren(document.getElementById("home-template").content.cloneNode(true));
      enableCardMotion();
      void loadBlog(content.querySelector("#home-project-list"));
      void loadCalendar(content.querySelector(".home-calendar .student-calendar"), { rolling: true });
    } else if (pageRoute === "/members") {
      content.replaceChildren(document.getElementById("members-template").content.cloneNode(true));
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.textContent = "Loading people…";
      content.querySelector(".members-years").append(status);
      void loadPeople(status);
    } else if (pageRoute === "/by-laws") {
      content.replaceChildren(document.getElementById("governance-template").content.cloneNode(true));
    } else if (pageRoute === "/events") {
      content.replaceChildren(document.getElementById("events-template").content.cloneNode(true));
      void loadCalendar(content.querySelector(".student-calendar"));
    } else {
      const heading = document.createElement("h1");
      heading.textContent = title;
      const paragraph = document.createElement("p");
      paragraph.textContent = "This route does not have a placeholder page.";
      content.replaceChildren(heading, paragraph);
    }
    document.title = `${title} | CTSG`;
    // Wait for the parent's initial route so embedded deep links count once.
    if (!embedded || parentOrigin) trackPageView(pageRoute, document.title);
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
