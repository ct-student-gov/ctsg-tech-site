import { calendarEndpoint, publishedCalendarFeed } from "./calendar-config.js";

const ZONE = "America/New_York";
const DAY = 86400000;
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: ZONE });
const fullDate = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
export function dateKey(value) {
  if (/^\d{4}-\d\d-\d\d$/.test(value)) return value;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: ZONE }).formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function lastDay(event) {
  if (event.end === event.start) return dateKey(event.start);
  return event.allDay ? new Date(Date.parse(event.end) - DAY).toISOString().slice(0, 10) : dateKey(new Date(Date.parse(event.end) - 1).toISOString());
}
export const eventsOnDay = (events, day) => events.filter(event => dateKey(event.start) <= day && lastDay(event) >= day);
export function eventFilter(event) {
  if (event.source === "career-management" || event.sourceIds?.includes("career-management")) return "career-management";
  if (["student-affairs", "inclusion-belonging", "tech-events"].includes(event.source)) return "student-affairs";
  return event.source === "tech-academic" ? "academic" : event.source === "clubs" && event.category === "CTSG events" ? "ctsg" : event.source;
}
export function matchesCalendarSource(event, enabled) {
  const groups = new Set((event.sourceIds || [event.source]).map(source => eventFilter({ ...event, source, sourceIds: [], category: event.sourceCategories?.[source] || event.category })));
  // Career cohosts belong to the Career group instead of Student Affairs.
  if (groups.has("career-management")) groups.delete("student-affairs");
  return [...groups].some(group => enabled.has(group));
}
const eventLabel = event => ({ "student-affairs": "Student Affairs", "career-management": "Career Management" })[eventFilter(event)] || event.category;
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const rangeFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export function calendarRange(anchor, view) {
  const month = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  let start = view === "rolling" ? new Date(+anchor) : view === "week" ? new Date(+anchor - anchor.getUTCDay() * DAY) : month;
  let end = view === "week" || view === "rolling" ? new Date(+start + 7 * DAY) : new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
  if (view === "month") {
    // Include the adjacent-month days drawn in the first and last grid rows.
    start = new Date(+start - start.getUTCDay() * DAY);
    end = new Date(+end + (7 - end.getUTCDay()) % 7 * DAY);
  }
  return { start, end };
}

export function mountCalendar(root, { rolling = false } = {}) {
  let today = dateKey(new Date().toISOString());
  let anchor = new Date(`${today}T00:00:00Z`);
  let data = null;
  let loading = false;
  let disposed = false;
  const abort = new AbortController();
  const controls = root.querySelector(".calendar-controls");
  const heading = root.querySelector(".calendar-month");
  const display = root.querySelector(".calendar-display");
  const status = root.querySelector(".calendar-status");
  let track = null;
  let firstTrackDay = 0;
  let dayStep = 106;
  let visibleDays = 7;
  let resizeObserver = null;
  let scrollTimer = null;
  let weekScrollTarget = null;
  const mobileViewport = window.matchMedia("(max-width: 650px)");
  let currentView = rolling ? "rolling" : mobileViewport.matches ? "list" : "month";
  const viewInputs = [...root.querySelectorAll("[name=calendar-view]")];
  viewInputs.forEach(input => { input.checked = input.value === currentView; });
  const menus = [...root.querySelectorAll(".calendar-menu")];
  for (const menu of menus) {
    menu.querySelector("summary").addEventListener("click", () => {
      menus.filter(other => other !== menu).forEach(other => { other.open = false; });
    });
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape") { menu.open = false; menu.querySelector("summary").focus(); }
    });
  }
  document.addEventListener("click", event => {
    menus.filter(menu => !menu.contains(event.target)).forEach(menu => { menu.open = false; });
  }, { signal: abort.signal });
  const dialog = root.querySelector("dialog");
  const detail = dialog.querySelector(".calendar-dialog-body");
  dialog.querySelector("button").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });

  function showEvent(event) {
    const title = node("h3", event.title);
    title.id = "calendar-event-title";
    const startDay = dateKey(event.start);
    const endDay = lastDay(event);
    let when = fullDate.format(new Date(startDay + "T00:00:00Z"));
    if (endDay !== startDay) when += ` – ${fullDate.format(new Date(endDay + "T00:00:00Z"))}`;
    when += event.allDay ? " · All day" : ` · ${timeFormat.format(new Date(event.start))}${event.end !== event.start ? `–${timeFormat.format(new Date(event.end))}` : ""} (New York time)`;
    detail.replaceChildren(title, node("p", when), node("p", eventLabel(event)));
    if (event.organizer && eventFilter(event) !== "ctsg") detail.append(node("p", event.organizer));
    if (event.audienceTags?.length) detail.append(node("p", `Audience: ${event.audienceTags.join(", ")}`));
    if (event.location) detail.append(node("p", event.location));
    if (event.description) detail.append(node("p", event.description, "calendar-description"));
    if (/^https?:\/\//i.test(event.url || "")) {
      const link = node("a", eventFilter(event) === "academic" ? "View official academic calendar" : "Event details and registration");
      link.href = event.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      detail.append(link);
    }
    dialog.showModal();
  }

  function eventButton(event) {
    const group = eventFilter(event);
    const button = node("button", undefined, `calendar-event calendar-event--${group === "ctsg" ? "clubs" : group}`);
    if (eventFilter(event) === "academic" && /\b(?:break|holiday|no classes)\b/i.test(event.title)) button.classList.add("calendar-event--break");
    button.type = "button";
    const time = event.allDay ? "All day" : timeFormat.format(new Date(event.start));
    const text = node("span", undefined, "calendar-event-text");
    text.append(node("span", time, "calendar-event-time"), document.createTextNode(" "), node("span", event.title));
    button.append(text);
    button.setAttribute("aria-label", `${time}: ${event.title}, ${eventLabel(event)}`);
    button.addEventListener("click", () => showEvent(event));
    return button;
  }

  function rollingDay(timestamp) {
    const date = new Date(timestamp);
    const key = date.toISOString().slice(0, 10);
    const column = node("section", undefined, "home-calendar-day");
    if (key === today) column.classList.add("home-calendar-day--today");
    column.setAttribute("aria-label", fullDate.format(date));
    const dayHeading = node("h4");
    const body = node("div", undefined, "home-calendar-day-body");
    const day = date.getUTCDate();
    const suffix = day >= 11 && day <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th");
    const label = node("time", date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }) + suffix, "calendar-day");
    label.dateTime = key;
    if (key === today) label.setAttribute("aria-current", "date");
    dayHeading.append(label);
    column.append(dayHeading);
    const events = eventsOnDay(data?.events ?? [], key);
    for (const event of events) body.append(eventButton(event));
    if (data && !events.length) {
      const inWindow = key >= dateKey(data.window.start) && key < dateKey(data.window.end);
      body.append(node("span", inWindow ? "No events" : "Events not available yet", "calendar-event-time"));
    }
    column.append(body);
    return column;
  }

  function sizeRollingDays() {
    const gap = 6;
    visibleDays = Math.max(1, Math.min(7, Math.floor((display.clientWidth + gap) / (160 + gap))));
    const width = Math.floor((display.clientWidth - gap * (visibleDays - 1)) / visibleDays * 64) / 64;
    dayStep = width + gap;
    display.style.setProperty("--calendar-day-width", `${width}px`);
    display.style.setProperty("--calendar-day-gap", `${gap}px`);
  }

  function updateRollingRange() {
    anchor = new Date(firstTrackDay + Math.floor((display.scrollLeft + .5) / dayStep) * DAY);
    heading.textContent = rangeFormat.formatRange(anchor, new Date(+anchor + (visibleDays - 1) * DAY));
  }

  function extendRollingTrack() {
    if (!track) return;
    if (display.scrollLeft < dayStep * 7) {
      const offset = display.scrollLeft;
      firstTrackDay -= 28 * DAY;
      const days = Array.from({ length: 28 }, (_, day) => rollingDay(firstTrackDay + day * DAY));
      track.prepend(...days);
      display.scrollLeft = offset + dayStep * 28;
    }
    if (display.scrollWidth - display.scrollLeft - display.clientWidth < dayStep * 7) {
      const start = firstTrackDay + track.children.length * DAY;
      track.append(...Array.from({ length: 28 }, (_, day) => rollingDay(start + day * DAY)));
    }
    updateRollingRange();
  }

  function renderRolling() {
    // Refresh event contents without replacing snap targets or resetting a gesture.
    if (track) {
      [...track.children].forEach((column, day) => {
        const updated = rollingDay(firstTrackDay + day * DAY);
        column.className = updated.className;
        column.replaceChildren(...updated.childNodes);
      });
      return;
    }
    firstTrackDay = +anchor - 28 * DAY;
    sizeRollingDays();
    track = node("div", undefined, "home-calendar-track");
    track.append(...Array.from({ length: 70 }, (_, day) => rollingDay(firstTrackDay + day * DAY)));
    display.replaceChildren(track);
    display.scrollLeft = dayStep * 28;
    updateRollingRange();
  }

  if (rolling) {
    const settleScroll = () => {
      clearTimeout(scrollTimer);
      weekScrollTarget = null;
      extendRollingTrack();
    };
    // Leave native momentum and snapping alone; extend the track only at rest.
    display.addEventListener("scrollend", settleScroll, { signal: abort.signal });
    display.addEventListener("scroll", () => {
      if (!("onscrollend" in display)) {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(settleScroll, 180);
      }
    }, { passive: true, signal: abort.signal });
    for (const type of ["wheel", "pointerdown", "keydown"]) {
      display.addEventListener(type, () => { weekScrollTarget = null; }, { passive: true, signal: abort.signal });
    }
    resizeObserver = new ResizeObserver(() => {
      if (!track) return;
      const offset = Math.round(display.scrollLeft / dayStep);
      const previousStep = dayStep;
      sizeRollingDays();
      if (previousStep === dayStep) return;
      weekScrollTarget = null;
      display.scrollLeft = offset * dayStep;
      updateRollingRange();
    });
    resizeObserver.observe(display);
  }

  function render() {
    if (rolling) { renderRolling(); return; }
    if (mobileViewport.matches) {
      currentView = "list";
      root.querySelector(".calendar-sort-menu").open = false;
    }
    viewInputs.forEach(input => { input.checked = input.value === currentView; });
    const { start, end } = calendarRange(anchor, currentView);
    const month = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    const isWeek = currentView === "week" || rolling;
    heading.textContent = isWeek ? rangeFormat.formatRange(start, new Date(+end - DAY)) : monthFormat.format(month);
    if (!rolling) {
      root.querySelector(".calendar-sort-menu summary").setAttribute("aria-label", `Calendar view: ${currentView[0].toUpperCase() + currentView.slice(1)}`);
      const previous = controls.querySelector("[data-direction='-1']");
      const next = controls.querySelector("[data-direction='1']");
      previous.setAttribute("aria-label", isWeek ? "Previous week" : "Previous month");
      next.setAttribute("aria-label", isWeek ? "Next week" : "Next month");
    }
    display.replaceChildren();
    if (!data && !rolling) return;
    const enabled = new Set([...root.querySelectorAll("input[name=calendar-source]:checked")].map(input => input.value));
    const firstDay = start.toISOString().slice(0, 10);
    const afterLastDay = end.toISOString().slice(0, 10);
    const events = (data?.events ?? []).filter(event => (rolling || matchesCalendarSource(event, enabled)) && dateKey(event.start) < afterLastDay && lastDay(event) >= firstDay);
    if (data) {
      const navigationRange = currentView === "month" ? calendarRange(anchor, "list") : { start, end };
      controls.querySelector("[data-direction='-1']").disabled = navigationRange.start.toISOString().slice(0, 10) <= dateKey(data.window.start);
      controls.querySelector("[data-direction='1']").disabled = navigationRange.end.toISOString().slice(0, 10) >= dateKey(data.window.end);
    }
    if (currentView === "list") {
      if (!events.length) display.append(node("p", "No events listed for this month and selection."));
      const list = node("ul", undefined, "calendar-agenda");
      for (const event of events) {
        const item = node("li");
        item.append(node("span", fullDate.format(new Date(dateKey(event.start) + "T00:00:00Z")), "calendar-agenda-date"), eventButton(event), node("span", eventLabel(event), "calendar-agenda-source"));
        list.append(item);
      }
      display.append(list);
    } else {
      const table = node("table", undefined, `calendar-grid${isWeek ? " calendar-grid--week" : ""}`);
      table.setAttribute("aria-label", `${heading.textContent} events`);
      const head = node("thead"), headings = node("tr");
      const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      for (let day = 0; day < 7; day++) {
        const cell = node("th", weekdays[(day + (rolling ? start.getUTCDay() : 0)) % 7]); cell.scope = "col"; headings.append(cell);
      }
      head.append(headings); table.append(head);
      const body = node("tbody");
      const first = isWeek ? start : new Date(+month - month.getUTCDay() * DAY);
      const count = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
      for (let week = 0; week < (isWeek ? 1 : Math.ceil((count + month.getUTCDay()) / 7)); week++) {
        const row = node("tr");
        for (let day = 0; day < 7; day++) {
          const date = new Date(+first + (week * 7 + day) * DAY);
          const dateString = date.toISOString().slice(0, 10);
          const cell = node("td");
          if (!isWeek && date.getUTCMonth() !== month.getUTCMonth()) cell.className = "calendar-outside-month";
          const number = node("time", rolling ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : String(date.getUTCDate()), "calendar-day");
          number.dateTime = dateString;
          number.setAttribute("aria-label", fullDate.format(date));
          if (dateString === today) number.setAttribute("aria-current", "date");
          const content = node("div", undefined, "calendar-cell");
          const eventList = node("div", undefined, "calendar-cell-events");
          content.append(number, eventList);
          cell.append(content);
          const dayEvents = eventsOnDay(events, dateString);
          for (const event of dayEvents) eventList.append(eventButton(event));
          if (rolling && data && !dayEvents.length) eventList.append(node("span", "No events", "calendar-event-time"));
          row.append(cell);
        }
        body.append(row);
      }
      table.append(body); display.append(table);
    }
  }

  controls?.addEventListener("click", event => {
    const button = event.target.closest("button[data-direction]");
    if (!button) return;
    const direction = Number(button.dataset.direction);
    if (rolling) {
      weekScrollTarget = (weekScrollTarget ?? Math.round(display.scrollLeft / dayStep)) + direction * visibleDays;
      display.scrollTo({ left: weekScrollTarget * dayStep, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      return;
    }
    anchor = currentView === "week" ? new Date(+anchor + direction * 7 * DAY) : new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + direction, 1));
    render();
  });
  root.querySelector("[data-reset]")?.addEventListener("click", () => {
    today = dateKey(new Date().toISOString());
    const target = Date.parse(`${today}T00:00:00Z`);
    weekScrollTarget = (target - firstTrackDay) / DAY;
    if (weekScrollTarget < 0 || weekScrollTarget >= track.children.length) {
      anchor = new Date(target);
      track = null;
      weekScrollTarget = null;
      renderRolling();
    } else {
      renderRolling();
      display.scrollTo({ left: weekScrollTarget * dayStep, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }
  });
  if (!rolling) mobileViewport.addEventListener("change", render, { signal: abort.signal });
  root.querySelector(".calendar-filters")?.addEventListener("change", render);
  root.querySelector(".calendar-views")?.addEventListener("change", event => {
    currentView = event.target.value;
    root.querySelector(".calendar-sort-menu").open = false;
    root.querySelector(".calendar-sort-menu summary").focus();
    render();
  });
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  // Both previews and production read the built repository snapshot.
  const endpoint = calendarEndpoint;
  const subscriptionMenu = root.querySelector(".calendar-subscription-menu");
  if (subscriptionMenu) {
    const feed = new URL("./data/calendar.ics", import.meta.url);
    // Calendar providers fetch feeds from their servers, so localhost cannot be
    // used for subscriptions. Keep the local feed for direct downloads only.
    const subscriptionFeed = publishedCalendarFeed;
    const webcal = subscriptionFeed.replace(/^https?:/, "webcal:");
    const providers = {
      google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(subscriptionFeed)}`,
      apple: webcal,
      outlook: `https://outlook.office.com/calendar/0/addfromweb?url=${encodeURIComponent(subscriptionFeed)}&name=${encodeURIComponent("Cornell Tech Events")}`,
    };
    for (const link of subscriptionMenu.querySelectorAll("[data-calendar-provider]")) {
      link.href = providers[link.dataset.calendarProvider];
    }
    root.querySelector(".calendar-download").href = feed.href;
    const field = subscriptionMenu.querySelector(".calendar-feed-field");
    const input = field.querySelector("input");
    const copyStatus = subscriptionMenu.querySelector(".calendar-copy-status");
    input.value = subscriptionFeed;
    const revealLink = () => { field.hidden = false; input.focus(); input.select(); };
    input.addEventListener("click", () => input.select());
    subscriptionMenu.querySelector("[data-calendar-copy]").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(subscriptionFeed);
        if (!disposed) copyStatus.textContent = "Calendar link copied.";
      } catch {
        if (!disposed) { copyStatus.textContent = "Select and copy this calendar link."; revealLink(); }
      }
    });
  }

  async function load() {
    if (loading || disposed) return;
    loading = true;
    try {
      let response;
      let savedCopy = !endpoint;
      if (endpoint) {
        try {
          response = await fetch(endpoint, { signal: abort.signal, ...(local ? { cache: "no-store" } : {}) });
          if (!response.ok) throw new Error("Calendar service unavailable");
        } catch (error) { if (abort.signal.aborted) return; savedCopy = true; }
      }
      if (savedCopy) response = await fetch(new URL("./data/calendar.json", import.meta.url), { signal: abort.signal });
      if (!response.ok) throw new Error("Calendar unavailable");
      const next = await response.json();
      if (!Array.isArray(next.events) || !Array.isArray(next.sources) || !next.window) throw new Error("Invalid calendar data");
      if (disposed) return;
      data = next; status.hidden = true; status.textContent = ""; render();
    } catch (error) {
      if (!abort.signal.aborted) { status.hidden = false; status.textContent = "Calendar could not be loaded. Please try again later."; }
    } finally { loading = false; }
  }
  render(); load();
  const interval = setInterval(load, 15 * 60 * 1000);
  const dayInterval = rolling ? setInterval(() => {
    const nextDay = dateKey(new Date().toISOString());
    if (nextDay !== today) {
      const followToday = anchor.toISOString().slice(0, 10) === today;
      today = nextDay;
      render();
      if (followToday) display.scrollTo({ left: (Date.parse(`${today}T00:00:00Z`) - firstTrackDay) / DAY * dayStep, behavior: "instant" });
    }
  }, 60 * 1000) : null;
  return () => { disposed = true; clearInterval(interval); clearInterval(dayInterval); clearTimeout(scrollTimer); resizeObserver?.disconnect(); abort.abort(); if (dialog.open) dialog.close(); };
}
