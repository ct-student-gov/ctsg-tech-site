import { parseFragment } from "parse5";
import { addDay, departmentEventEligible, wallTime, windowFor, ZONE } from "./sources.mjs";

export const TECH_EVENTS_URL = "https://tech.cornell.edu/events/";
const API_URL = "https://tech.cornell.edu/wp-json/crn/filter/events";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_DETAILS = 100;
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value || "";
const hasClass = (node, name) => attr(node, "class").split(/\s+/).includes(name);
const text = node => node.nodeName === "#text" ? node.value : (node.childNodes || []).map(text).join(node.tagName === "p" ? " " : "");
const clean = node => text(node).replace(/\s+/g, " ").trim();
function find(root, predicate) {
  const found = [];
  const visit = node => { if (predicate(node)) found.push(node); (node.childNodes || []).forEach(visit); };
  visit(root);
  return found;
}
const one = (root, className) => find(root, node => hasClass(node, className))[0];
const tags = (root, group) => [...new Set(find(root, node => attr(node, "data-group") === group).map(clean))];

function officialUrl(value, base = TECH_EVENTS_URL, detail = false) {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !(url.hostname === "cornell.edu" || url.hostname.endsWith(".cornell.edu") || ["gomry.com", "www.gomry.com"].includes(url.hostname))) {
    throw new Error("Cornell Tech organizer URL is outside supported public sources");
  }
  if (detail && (url.origin !== "https://tech.cornell.edu" || !/^\/events\/[^/]+\/$/.test(url.pathname))) throw new Error("Cornell Tech event link changed");
  url.hash = "";
  return url;
}

async function download(url, fetcher, json = false) {
  let current = officialUrl(url);
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetcher(current.href, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { Accept: json ? "application/json" : "text/html", "User-Agent": "CTSG-Calendar/1.0" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (!location) throw new Error("Cornell Tech source redirect is missing its destination");
      current = officialUrl(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`Cornell Tech source returned HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > 3000000) throw new Error("Cornell Tech source exceeded response size limit");
    return json ? JSON.parse(body) : body;
  }
  throw new Error("Cornell Tech source exceeded redirect limit");
}

export function parseTechEventsListing(data) {
  if (!data || typeof data.html !== "string" || ![data.count, data.total, data.totalPages].every(n => Number.isSafeInteger(n) && n >= 0)
    || data.count > PAGE_SIZE || data.totalPages > MAX_PAGES || data.totalPages !== Math.ceil(data.total / PAGE_SIZE)) {
    throw new Error("Cornell Tech listing pagination format changed");
  }
  const cards = find(parseFragment(data.html), node => hasClass(node, "event-filter-item"));
  if (cards.length !== data.count || (data.total > 0 && !cards.length)) throw new Error("Cornell Tech listing event count does not match parsed cards");
  return cards.map(card => {
    const link = one(card, "event-filter-item__title");
    const title = link && clean(link);
    const monthDay = one(card, "event-filter-item__month");
    if (!title || !monthDay || !/^\d{2}\/\d{2}$/.test(clean(monthDay))) throw new Error("Cornell Tech listing event fields changed");
    return {
      title, url: officialUrl(attr(link, "href"), TECH_EVENTS_URL, true).href,
      audienceTags: tags(card, "open_to"), eventTypes: tags(card, "event_type"),
      monthDay: clean(monthDay), weekday: clean(one(card, "event-filter-item__day") || { childNodes: [] }),
      hours: clean(one(card, "event-filter-item__open-close-hour") || { childNodes: [] }),
    };
  });
}

export function techEventEligible(event) {
  if (!departmentEventEligible(event)) return false;
  const audiences = event.audienceTags || [];
  const currentStudents = audiences.some(tag => !/prospective|admitted|high school/i.test(tag) && /student|\bphds?\b|doctoral|\bmba\b|\bm\.?eng\b|\bll\.?m\b/i.test(tag));
  if (!currentStudents && (event.eventTypes || []).some(tag => /admissions/i.test(tag))) return false;
  if (audiences.length && !currentStudents && !audiences.some(tag => /^(?:public|everyone|all|cornell tech community|roosevelt island community)$/i.test(tag))) return false;
  return true;
}

function isoValue(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) throw new Error("Cornell Tech event requires a full source date");
  const day = value.slice(0, 10);
  if (!Number.isFinite(Date.parse(value)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error("Cornell Tech event has an invalid date");
  return value.length === 10 ? value : wallTime(value);
}

function displayedDate(value) {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const match = value.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})\s*(AM|PM))?/i);
  if (!match) return null;
  const month = months.indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
  if (!month) return null;
  const day = `${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return isoValue(match[4] ? `${day}T${clock(match[4], match[5], match[6])}:00` : day);
}

function clock(hour, minute, meridiem) {
  if (+hour < 1 || +hour > 12 || +minute > 59) throw new Error("Cornell Tech event has an invalid time");
  return `${String(+hour % 12 + (/pm/i.test(meridiem) ? 12 : 0)).padStart(2, "0")}:${minute}`;
}

function sourceDates(html) {
  // JSON-LD contains event dates, unlike publication/modification timestamps.
  const candidates = [];
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if ((Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]]).some(type => /(?:^|\/)\w*Event$/.test(type || "")) && value.startDate) candidates.push(value);
    if (Array.isArray(value)) value.forEach(visit);
    else if (value["@graph"]) visit(value["@graph"]);
  };
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* Other schema blocks are not event data. */ }
  }
  if (candidates.length > 1) throw new Error("Cornell Tech organizer has ambiguous event dates");
  if (candidates.length) return { start: isoValue(candidates[0].startDate), end: candidates[0].endDate ? isoValue(candidates[0].endDate) : null, cancelled: /Event(?:Cancelled|Postponed)$/.test(candidates[0].eventStatus || "") };
  // Cornell AAP's event header includes a full year. Restrict this fallback to
  // the event header; related-event and publication dates are not evidence.
  const times = [...html.matchAll(/<time\b[^>]*>[\s\S]*?<\/time>/gi)].map(match => parseFragment(match[0]).childNodes[0]);
  const starts = times.filter(node => hasClass(node, "event__topper-date") || attr(node, "itemprop") === "startDate")
    .map(node => attr(node, "datetime") ? isoValue(attr(node, "datetime")) : displayedDate(clean(node))).filter(Boolean);
  if (new Set(starts).size > 1) throw new Error("Cornell Tech organizer has ambiguous event dates");
  return starts.length ? { start: starts[0], end: null } : null;
}

const localParts = value => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(value)).map(part => [part.type, part.value]));

export function parseTechEventDetail(html, listing, organizerHtml = "") {
  // Keep navigation, scripts, and related-event dates outside the detail DOM.
  const section = html.match(/<section\b[^>]*class=["'][^"']*\bevent-details\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/i);
  if (!section) throw new Error("Cornell Tech event detail section not found");
  const root = parseFragment(section[1]);
  const title = one(root, "event-card__title");
  if (!title || !clean(title)) throw new Error("Cornell Tech event detail title not found");
  const detailAudiences = tags(root, "open_to");
  const detailTypes = tags(root, "event_type");
  const audienceTags = detailAudiences.length ? detailAudiences : listing.audienceTags;
  const eventTypes = detailTypes.length ? detailTypes : listing.eventTypes;
  const descriptionNode = one(root, "wysiwyg--event-details");
  const description = descriptionNode ? clean(descriptionNode) : "";
  if (!techEventEligible({ title: clean(title), audienceTags, eventTypes, description })) return { excluded: true };
  const sidebar = find(root, node => hasClass(node, "event-details-sidebar__item"));
  const field = name => sidebar.find(node => clean(one(node, "event-details-sidebar__item-title") || { childNodes: [] }) === name);
  const when = field("When");
  const dates = sourceDates(html) || (when && displayedDate(clean(when)) ? { start: displayedDate(clean(when)), end: null } : null) || (organizerHtml && sourceDates(organizerHtml));
  const links = find(root, node => node.tagName === "a" && hasClass(node, "event-details-sidebar__item-button"));
  const organizerUrl = links.length ? attr(links[0], "href") : "";
  if (!dates) return { organizerUrl };
  if (dates.cancelled) return { excluded: true };
  let { start, end } = dates;
  let allDay = start.length === 10;
  let parts = allDay ? { year: start.slice(0, 4), month: start.slice(5, 7), day: start.slice(8, 10), weekday: new Date(start).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }) } : localParts(start);
  if (`${parts.month}/${parts.day}` !== listing.monthDay || (listing.weekday && parts.weekday !== listing.weekday)) throw new Error("Cornell Tech listing and organizer dates disagree");
  const range = listing.hours.match(/^(\d{1,2}):(\d{2})\s*(am|pm)\s*[-–—]\s*(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (range) {
    if (allDay) {
      if (end) throw new Error("Cornell Tech event mixes date-only and timed ranges");
      start = wallTime(`${start}T${clock(range[1], range[2], range[3])}:00`);
      parts = localParts(start);
      allDay = false;
    }
    if (`${parts.hour}:${parts.minute}` !== clock(range[1], range[2], range[3])) throw new Error("Cornell Tech listing and organizer times disagree");
    const finish = clock(range[4], range[5], range[6]);
    if (!end) {
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      if (finish <= `${parts.hour}:${parts.minute}`) throw new Error("Cornell Tech overnight event requires a full end date");
      end = wallTime(`${day}T${finish}:00`);
    }
  }
  if (allDay && listing.hours && !/^all[ -]day$/i.test(listing.hours)) throw new Error("Cornell Tech advertised event time format changed");
  if (allDay) end = addDay(end || start);
  else if (end?.length === 10) throw new Error("Cornell Tech event mixes date-only and timed ranges");
  // A missing end remains a point event; never invent a one-hour duration.
  if (!end) end = start;
  if (end < start) throw new Error("Cornell Tech event ends before it starts");
  const where = field("Where");
  let registrationUrl;
  for (const link of find(root, node => node.tagName === "a")) {
    let url;
    try { url = new URL(attr(link, "href"), TECH_EVENTS_URL); } catch { continue; }
    const id = url.searchParams.get("id");
    if (url.origin === "https://cornelltech.campusgroups.com" && /\/rsvp(?:_boot)?$/.test(url.pathname) && /^\d+$/.test(id || "")) registrationUrl = `https://cornelltech.campusgroups.com/rsvp?id=${id}`;
  }
  return { event: {
    id: `tech-events:${new URL(listing.url).pathname.split("/").filter(Boolean).at(-1)}`,
    source: "tech-events", category: "Cornell Tech events", title: clean(title), start, end, allDay,
    description: description || "See the official event page for details and registration.",
    location: where ? clean(one(where, "event-details-sidebar__item-description") || { childNodes: [] }) : "",
    url: listing.url, audienceTags, ...(registrationUrl ? { registrationUrl } : {}),
  } };
}

export async function loadTechEvents(fetcher = fetch, now = new Date(), { archivedIds = new Set() } = {}) {
  const listings = [];
  const seen = new Set();
  let total, pages;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(API_URL);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("paged", String(page));
    url.searchParams.set("offset", String((page - 1) * PAGE_SIZE));
    const data = await download(url.href, fetcher, true);
    const records = parseTechEventsListing(data);
    if (page === 1) { total = data.total; pages = data.totalPages; }
    if (data.total !== total || data.totalPages !== pages) throw new Error("Cornell Tech listing changed during pagination; retry required");
    for (const record of records) {
      if (seen.has(record.url)) throw new Error("Cornell Tech listing pagination repeated an event");
      seen.add(record.url); listings.push(record);
    }
    if (page >= pages) break;
  }
  if (listings.length !== total) throw new Error("Cornell Tech listing pagination is incomplete");
  const eligibleListings = listings.filter(techEventEligible);
  // The listing endpoint is a whole-feed download. Known archived events do
  // not need their individual detail/organizer pages downloaded again.
  const eligible = eligibleListings.filter(listing => !archivedIds.has(`tech-events:${new URL(listing.url).pathname.split("/").filter(Boolean).at(-1)}`));
  if (eligible.length > MAX_DETAILS) throw new Error("Cornell Tech event detail safety limit exceeded");
  const events = [];
  const issues = [];
  let excludedCount = total - eligibleListings.length;
  const window = windowFor(now);
  // Small batches limit open connections and avoid an unbounded scrape fanout.
  for (let index = 0; index < eligible.length; index += 3) {
    const batch = await Promise.all(eligible.slice(index, index + 3).map(async listing => {
      try {
        const html = await download(listing.url, fetcher);
        let result = parseTechEventDetail(html, listing);
        if (!result.event && !result.excluded && result.organizerUrl) result = parseTechEventDetail(html, listing, await download(officialUrl(result.organizerUrl).href, fetcher));
        if (result.excluded) return { excluded: true };
        if (!result.event) throw new Error("Cornell Tech event has no verified full date");
        return result;
      } catch (error) {
        // One unsupported organizer must not prevent verified events from
        // refreshing. Report every omission so coverage checks can alert.
        return { issue: { url: listing.url, message: String(error?.message || "Event could not be verified").slice(0, 300) } };
      }
    }));
    for (const result of batch) {
      if (result.issue) { issues.push(result.issue); continue; }
      if (result.excluded) { excludedCount++; continue; }
      const event = result.event;
      if (Date.parse(event.end) >= Date.parse(window.start) && Date.parse(event.start) < Date.parse(window.end)) events.push(event);
    }
  }
  const failedCount = issues.length;
  const warnings = failedCount ? [{ code: "unverified-events", message: `${failedCount} Cornell Tech event${failedCount === 1 ? " was" : "s were"} omitted because full event details or dates could not be verified. See source diagnostics.` }] : [];
  return { events, fetchedCount: total, excludedCount, failedCount, warnings, diagnostics: { fetchedCount: total, excludedCount, importedCount: events.length, pagesFetched: Math.max(pages, 1), failedCount, issues } };
}
