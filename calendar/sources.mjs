import ICAL from "ical.js";
import { parse } from "parse5";

export const STUDENT_AFFAIRS_URL = "https://cornelltech.campusgroups.com/ical/cornelltech/ical_club_37005.ics";
export const ACADEMIC_URL = "https://registrar.cornell.edu/calendars-exams/academic-calendar";
export const NOTION_SOURCE = "3e90b1bd-6791-8091-bca0-000bcfad61a1";
export const ZONE = "America/New_York";
const DAY = 86400000;
const wallTimeFormats = new Map();
export const addDay = date => new Date(Date.parse(date) + DAY).toISOString().slice(0, 10);
export const safeUrl = value => /^https?:\/\//i.test(value ?? "") ? value : "";

export function windowFor(now = new Date()) {
  return { start: new Date(+now - 90 * DAY).toISOString(), end: new Date(+now + 400 * DAY).toISOString() };
}

export function wallTime(value, zone = ZONE) {
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return new Date(value).toISOString();
  const target = Date.parse(value + "Z");
  let stamp = target;
  if (!wallTimeFormats.has(zone)) wallTimeFormats.set(zone, new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }));
  const format = wallTimeFormats.get(zone);
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(format.formatToParts(stamp).map(p => [p.type, p.value]));
    const displayed = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    stamp += target - displayed;
  }
  return new Date(stamp).toISOString();
}

function timeValue(time, property) {
  if (time.isDate) return time.toString();
  const tzid = property?.getParameter("tzid");
  if (time.zone === ICAL.Timezone.localTimezone) return wallTime(time.toString(), tzid || ZONE);
  return time.toJSDate().toISOString();
}

export function parseICS(text, window = windowFor()) {
  if (!text.trimStart().startsWith("BEGIN:VCALENDAR")) throw new Error("Expected an ICS calendar");
  const calendar = new ICAL.Component(ICAL.parse(text));
  for (const zone of calendar.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(zone);
  const components = calendar.getAllSubcomponents("vevent");
  const events = [];
  const seen = new Set();
  const append = (event, start, end, recurrenceId = "") => {
    const component = event.component;
    if (component.getFirstPropertyValue("status") === "CANCELLED") return;
    const startValue = timeValue(start, component.getFirstProperty("dtstart"));
    const endValue = timeValue(end, component.getFirstProperty("dtend") || component.getFirstProperty("dtstart"));
    const id = `student-affairs:${event.uid}${recurrenceId ? `:${recurrenceId}` : ""}`;
    if (!event.summary || seen.has(id) || Date.parse(endValue) < Date.parse(window.start) || Date.parse(startValue) >= Date.parse(window.end)) return;
    seen.add(id);
    events.push({ id, source: "student-affairs", category: "School events", title: event.summary.trim(), start: startValue, end: endValue, allDay: start.isDate, description: event.description || "", location: /sign in to download/i.test(event.location || "") ? "See event page for location" : (event.location || "").trim(), url: safeUrl(component.getFirstPropertyValue("url")) });
  };
  for (const component of components) {
    const event = new ICAL.Event(component);
    if (event.isRecurrenceException()) continue; // Parent event applies exceptions by UID.
    if (!event.isRecurring()) { append(event, event.startDate, event.endDate); continue; }
    const iterator = event.iterator();
    let exhausted = false;
    for (let i = 0; i < 10000; i++) {
      const occurrence = iterator.next();
      if (!occurrence || Date.parse(timeValue(occurrence, component.getFirstProperty("dtstart"))) >= Date.parse(window.end)) { exhausted = true; break; }
      const detail = event.getOccurrenceDetails(occurrence);
      append(detail.item, detail.startDate, detail.endDate, occurrence.toString());
    }
    if (!exhausted) throw new Error("Recurrence expansion exceeded safety limit");
  }
  return events;
}

const textContent = node => node.nodeName === "#text" ? node.value : (node.childNodes || []).map(textContent).join("");
function findNodes(root, predicate) {
  const found = [];
  const visit = node => { if (predicate(node)) found.push(node); (node.childNodes || []).forEach(visit); };
  visit(root);
  return found;
}
const hasClass = (node, name) => node.attrs?.some(a => a.name === "class" && a.value.split(/\s+/).includes(name));

// The permanent URL publishes the current academic year. Read that year from
// the page on every refresh; no annual URL or hard-coded date updates are needed.
export function parseAcademic(html) {
  const document = parse(html);
  const heading = findNodes(document, n => n.tagName === "h1").map(textContent).join(" ");
  const rows = findNodes(document, n => hasClass(n, "calendar-row-item")).map(row => Object.fromEntries(
    ["calendar-date-title", "calendar-date", "calendar-time"].map(name => [name, findNodes(row, n => hasClass(n, name)).map(textContent).join(" ")])
  ));
  return academicEvents(heading, rows);
}

// Cloudflare's streaming parser avoids building a JavaScript DOM for the whole
// Registrar page and reduces CPU usage for free-plan scheduled refreshes.
export async function parseAcademicResponse(response) {
  if (typeof HTMLRewriter === "undefined") return parseAcademic(await response.text());
  let heading = "";
  const rows = [];
  const rewriter = new HTMLRewriter()
    .on("h1", { text(chunk) { heading += chunk.text; } })
    .on(".calendar-row-item", { element() { rows.push({}); } });
  for (const name of ["calendar-date-title", "calendar-date", "calendar-time"]) {
    rewriter.on(`.calendar-row-item .${name}`, { text(chunk) { const row = rows.at(-1); row[name] = (row[name] || "") + chunk.text; } });
  }
  await rewriter.transform(response).text();
  return academicEvents(heading, rows);
}

function academicEvents(heading, rows) {
  const yearMatch = heading.match(/Academic Calendar\s+(\d{4})\s*[-–]\s*(\d{4})/);
  if (!yearMatch || Number(yearMatch[2]) !== Number(yearMatch[1]) + 1) throw new Error("Academic calendar year not found or invalid");
  const academicYear = `${yearMatch[1]}–${yearMatch[2]}`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let year = Number(yearMatch[1]);
  let previousMonth = 0;
  const events = [];
  const ids = new Set();
  const date = (y, m, d) => {
    const value = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (!m || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Invalid academic calendar date");
    return value;
  };
  const timed = (day, match) => {
    const hour = Number(match[1]), minute = Number(match[2]);
    if (hour < 1 || hour > 12 || minute > 59) throw new Error("Invalid academic calendar time");
    return wallTime(`${day}T${String(hour % 12 + (/pm/i.test(match[3]) ? 12 : 0)).padStart(2, "0")}:${match[2]}:00`);
  };
  for (const row of rows) {
    const get = name => (row[name] || "").replace(/\s+/g, " ").trim();
    const title = get("calendar-date-title");
    const dates = get("calendar-date");
    const time = get("calendar-time");
    const match = dates.match(/^([A-Z][a-z]{2}) (\d{1,2})(?:\s*[–-]\s*(?:([A-Z][a-z]{2}) )?(\d{1,2}))?$/);
    if (!match) throw new Error("Academic calendar date format changed");
    const month = months.indexOf(match[1]) + 1;
    if (!month) throw new Error("Unknown academic calendar month");
    if (previousMonth > month) year++;
    if (year > Number(yearMatch[2])) throw new Error("Academic calendar dates exceed its academic year");
    previousMonth = month;
    const semester = /^(Fall|Spring)\s+\d{4}:/i.test(title);
    const enrollment = semester && /Cornell Tech/i.test(title) && /(?:enrollment|add\/drop).*?(?:begins|opens)/i.test(title);
    const deadline = semester && /last day to (?:add|drop|change).*(?:class|credit|grading basis)/i.test(title);
    const relevant = /\b(?:break|holiday|no classes)\b/i.test(title)
      || (semester && /term begins|last day of instruction.*(?:regular|full)|final exams|study (?:days|period)/i.test(title))
      || enrollment || deadline;
    if (!relevant) continue;
    const endMonth = match[3] ? months.indexOf(match[3]) + 1 : month;
    const startDay = date(year, month, match[2]);
    const endDay = date(year + (endMonth < month ? 1 : 0), endMonth, match[4] || match[2]);
    const times = [...time.matchAll(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/gi)];
    if (time && !/^All Day$/i.test(time) && !times.length) throw new Error("Academic calendar time format changed");
    if (times.length > 2 || (times.length === 1 && match[4])) throw new Error("Academic calendar time range changed");
    // Cornell renders full-day ranges as midnight through 11:59 PM. Keep
    // breaks and exam windows all-day; retain exact enrollment/deadline times.
    const allDay = !times.length || (!enrollment && !deadline && times.length === 2
      && times[0][1] === "12" && times[0][2] === "00" && /am/i.test(times[0][3])
      && times[1][1] === "11" && times[1][2] === "59" && /pm/i.test(times[1][3]));
    const start = allDay ? startDay : timed(startDay, times[0]);
    const end = allDay ? addDay(endDay) : timed(endDay, times.at(-1));
    if (end < start) throw new Error("Invalid academic calendar range");
    // Exclude the date from identity so rescheduling updates a subscription
    // entry instead of adding a second entry. The year distinguishes cohorts.
    const id = `academic:${academicYear}:${title}`;
    if (ids.has(id)) throw new Error("Duplicate academic calendar event");
    ids.add(id);
    events.push({ id, source: "academic", category: "Academic dates", title, start, end, allDay, description: "Cornell University Registrar academic calendar. Enrollment opening windows are filtered to Graduate/Professional/Cornell Tech. Course-session and program-specific dates may differ; exam periods are not individual course exam appointments.", location: "", url: ACADEMIC_URL });
  }
  if (events.length < 5) throw new Error("Academic calendar returned too few dates");
  return { events, academicYear };
}

const richText = property => (property?.title || property?.rich_text || []).map(t => t.plain_text ?? t.text?.content ?? "").join("");
export function notionEvent(page) {
  const p = page.properties || {};
  const approval = p["Approval status"];
  if ((approval?.status?.name ?? approval?.select?.name) !== "Approved" || page.archived || page.in_trash || page.is_archived) return null;
  if ((p["Event status"]?.select?.name ?? p["Event status"]?.status?.name) === "Cancelled") return null;
  const title = richText(p["Event Title"]).trim();
  const date = p.Date?.date;
  if (!title || !date?.start) return null;
  const allDay = /^\d{4}-\d\d-\d\d$/.test(date.start);
  const start = allDay ? date.start : wallTime(date.start, date.time_zone || ZONE);
  const end = allDay ? addDay(date.end || date.start) : date.end ? wallTime(date.end, date.time_zone || ZONE) : start;
  if (end < start) return null;
  const organizer = richText(p["Club Name"]).trim();
  const eventType = p["Event type"]?.select?.name;
  const isCTSG = eventType === "CTSG" || (!eventType && /^(CTSG|Cornell Tech Student Government)$/i.test(organizer));
  return { id: `notion:${page.id}`, source: "clubs", category: isCTSG ? "CTSG events" : "Club events", title, start, end, allDay, description: richText(p.Description), location: richText(p.Location), organizer, url: safeUrl(p["RSVP/details URL"]?.url) };
}

async function get(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  return response;
}

export async function loadNotion(env, fetcher = fetch) {
  if (!env.NOTION_TOKEN) throw new Error("Notion connection is not configured");
  const base = `https://api.notion.com/v1/data_sources/${env.NOTION_DATA_SOURCE_ID || NOTION_SOURCE}`;
  const headers = { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" };
  const schema = await (await get(base, { headers }, fetcher)).json();
  const type = schema.properties?.["Approval status"]?.type;
  if (!["status", "select"].includes(type)) throw new Error("Notion needs an Approval status property");
  const events = [];
  let cursor;
  do {
    const body = { page_size: 100, filter: { property: "Approval status", [type]: { equals: "Approved" } }, ...(cursor ? { start_cursor: cursor } : {}) };
    const result = await (await get(`${base}/query`, { headers, method: "POST", body: JSON.stringify(body) }, fetcher)).json();
    if (!Array.isArray(result.results) || result.request_status?.type === "incomplete") throw new Error("Incomplete Notion response");
    events.push(...result.results.map(notionEvent).filter(Boolean));
    cursor = result.has_more ? result.next_cursor : null;
    if (result.has_more && !cursor) throw new Error("Missing Notion pagination cursor");
  } while (cursor);
  return { events };
}

export async function loadSource(id, env = {}, fetcher = fetch, now = new Date()) {
  if (id === "student-affairs") return { events: parseICS(await (await get(STUDENT_AFFAIRS_URL, {}, fetcher)).text(), windowFor(now)) };
  if (id === "academic") return parseAcademicResponse(await get(ACADEMIC_URL, {}, fetcher));
  if (id === "clubs") return loadNotion(env, fetcher);
  throw new Error("Unknown calendar source");
}
