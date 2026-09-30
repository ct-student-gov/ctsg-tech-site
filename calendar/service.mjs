import { DEPARTMENT_SOURCES, STUDENT_SOURCES, NOTION_SOURCES, TECH_ACADEMIC_URL, departmentEventEligible, loadSource, loadStudentSource, windowFor } from "./sources.mjs";
import { TECH_EVENTS_URL, loadTechEvents } from "./tech-events.mjs";
import { mergeEvents } from "./merge.mjs";
import { sourceCoverage } from "./coverage.mjs";

export const SOURCES = [
  ...DEPARTMENT_SOURCES,
  { id: "tech-events", name: "Cornell Tech events", url: TECH_EVENTS_URL },
  ...NOTION_SOURCES.map(({ id, name }) => ({ id, name, url: "" })),
  { id: "academic", name: "Cornell academic dates", url: "https://registrar.cornell.edu/calendars-exams/academic-calendar" },
  { id: "tech-academic", name: "Cornell Tech academic dates", url: TECH_ACADEMIC_URL },
];
const TTL = 15 * 60 * 1000;

// Storage has the small get/put interface of Workers KV. The local preview
// supplies an in-memory implementation. Never store a token in these records.
export async function calendarData(env = {}, storage, { now = new Date(), fetcher = fetch, forceRefresh = false, archive, notionLoader, notionOnly = false } = {}) {
  if (archive) await archive.load();
  const configured = [...SOURCES, ...STUDENT_SOURCES.filter(source => env[source.secret])];
  const eligibleEvents = (source, events) => events
    .filter(event => !DEPARTMENT_SOURCES.some(department => department.id === event.source) || departmentEventEligible(event))
    .map(event => source.secret ? { ...event, detailsRedacted: true } : event);
  const results = await Promise.all(configured.map(async source => {
    const key = `calendar-v1:${source.id}`;
    const saved = await storage.get(key, "json");
    const isNotion = NOTION_SOURCES.some(notion => notion.id === source.id);
    if (isNotion && !env.NOTION_TOKEN) return { ...source, state: "unconfigured", updatedAt: null, events: [] };
    try {
      // Preserve ended events before a feed can omit them or the live cache is
      // replaced. Stable source/ID pairs are archived once, with no expiration.
      if (archive && saved) await archive.capture(source.id, eligibleEvents(source, saved.events), now);
      if (saved && ((!forceRefresh && +now - Date.parse(saved.updatedAt) < TTL) || (notionOnly && !isNotion))) return { ...source, ...saved, state: "current" };
      const archivedIds = new Set(archive?.events(source.id).map(event => event.id));
      const imported = await (isNotion && notionLoader ? notionLoader(source, saved?.events || []) : source.secret ? loadStudentSource(source, env, fetcher, now) : source.id === "tech-events" ? loadTechEvents(fetcher, now, { archivedIds }) : loadSource(source.id, env, fetcher, now));
      const eligible = eligibleEvents(source, imported.events);
      if (archive) await archive.capture(source.id, eligible, now);
      const events = eligible.filter(event => !archive?.has(source.id, event.id));
      const data = { ...imported, events, window: windowFor(now), excludedCount: (imported.excludedCount || 0) + imported.events.length - eligible.length, updatedAt: now.toISOString() };
      data.coverage = sourceCoverage(source, data, saved, now);
      data.coverage.warnings.push(...(imported.warnings || []));
      await storage.put(key, JSON.stringify(data));
      return { ...source, ...data, state: "current" };
    } catch (error) {
      console.warn(`Calendar source ${source.id}: ${error.message}`);
      // Avoid continuing to publish club events indefinitely after approval
      // access is lost. The same bound applies to student subscriptions.
      // Other public sources retain their last known data.
      const usable = saved && (!(isNotion || source.secret) || +now - Date.parse(saved.updatedAt) < 60 * 60 * 1000);
      return { ...source, ...(usable ? saved : { events: [], updatedAt: null }), state: saved ? "stale" : "unavailable", error: error.message };
    }
  }));
  const window = windowFor(now);
  const liveWindowStart = Date.parse(window.start);
  // Apply the audience rule to cached data too, including outage fallbacks.
  const events = results.flatMap(source => {
    // Removing a source's connection suppresses its archived records too.
    const history = source.state === "unconfigured" ? [] : eligibleEvents(source, archive?.events(source.id) || []);
    source.archivedCount = history.length;
    for (const event of history) {
      if (Date.parse(event.start) < Date.parse(window.start)) window.start = event.start;
    }
    const live = eligibleEvents(source, source.events).filter(event =>
      !archive?.has(source.id, event.id)
      && Date.parse(event.end) >= liveWindowStart
      && Date.parse(event.start) < Date.parse(window.end));
    return [...history, ...live];
  });
  const unique = mergeEvents(events);
  return { generatedAt: now.toISOString(), window, timeZone: "America/New_York", sources: results.map(({ events, secret, department, ...source }) => source), events: unique.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title)) };
}

export function memoryStorage() {
  const values = new Map();
  return { async get(key) { return values.has(key) ? JSON.parse(values.get(key)) : null; }, async put(key, value) { values.set(key, value); } };
}

export function toICS(data) {
  const escape = value => String(value || "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
  const date = value => value.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CTSG//Student Events//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Cornell Tech Student Events"];
  for (const event of data.events) {
    lines.push("BEGIN:VEVENT", `UID:${escape(event.id)}@ctsg.tech.cornell.edu`, `DTSTAMP:${date(data.generatedAt)}`, `DTSTART${event.allDay ? ";VALUE=DATE" : ""}:${date(event.start)}`);
    if (event.end > event.start) lines.push(`DTEND${event.allDay ? ";VALUE=DATE" : ""}:${date(event.end)}`);
    const description = [event.description, event.audienceTags?.length ? `Audience: ${event.audienceTags.join(", ")}` : ""].filter(Boolean).join("\n\n");
    lines.push(`SUMMARY:${escape(event.title)}`, `DESCRIPTION:${escape(description)}`, `LOCATION:${escape(event.location)}`, `CATEGORIES:${escape(event.category)}`);
    if (event.url) lines.push(`URL:${event.url.replace(/[\r\n]/g, "")}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  // RFC 5545 folding counts UTF-8 octets, not JavaScript characters.
  return lines.map(line => {
    let result = "", length = 0;
    for (const character of line) {
      const codePoint = character.codePointAt(0);
      const size = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      if (length + size > 75) { result += "\r\n "; length = 1; }
      result += character; length += size;
    }
    return result;
  }).join("\r\n") + "\r\n";
}

export async function calendarResponse(request, env, storage, options = {}) {
  const path = new URL(request.url).pathname;
  const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" };
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET" } });
  if (!["/api/calendar", "/api/calendar.ics"].includes(path)) return new Response("Not found", { status: 404, headers });
  const data = await calendarData(env, storage, options);
  if (path.endsWith(".ics")) return new Response(toICS(data), { headers: { ...headers, "Content-Type": "text/calendar; charset=utf-8" } });
  return Response.json(data, { headers });
}
