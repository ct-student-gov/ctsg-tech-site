import ICAL from "ical.js";
import { parse } from "parse5";

export const STUDENT_AFFAIRS_URL = "https://cornelltech.campusgroups.com/ical/cornelltech/ical_club_37005.ics";
export const INCLUSION_URL = "https://cornelltech.campusgroups.com/ical/cornelltech/ical_club_73165.ics";
export const CAREERS_URL = "https://cornelltech.campusgroups.com/ical/cornelltech/ical_club_20032.ics";
// Only these official departments are imported automatically. Club feeds
// continue to require the separate Notion approval process.
export const DEPARTMENT_SOURCES = [
  { id: "student-affairs", name: "Student Affairs", url: STUDENT_AFFAIRS_URL },
  { id: "inclusion-belonging", name: "Inclusion & Belonging", url: INCLUSION_URL },
  { id: "career-management", name: "Career Management", url: CAREERS_URL },
];
export const ACADEMIC_URL = "https://registrar.cornell.edu/calendars-exams/academic-calendar";
export const TECH_ACADEMIC_URL = "https://studentaffairs.tech.cornell.edu/academics/academic-calendar/";
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

export function parseICS(text, window = windowFor(), source = "student-affairs") {
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
    const id = `${source}:${event.uid}${recurrenceId ? `:${recurrenceId}` : ""}`;
    if (!event.summary || seen.has(id) || Date.parse(endValue) < Date.parse(window.start) || Date.parse(startValue) >= Date.parse(window.end)) return;
    seen.add(id);
    events.push({ id, source, category: "School events", title: event.summary.trim(), start: startValue, end: endValue, allDay: start.isDate, description: event.description || "", location: /sign in to download/i.test(event.location || "") ? "See event page for location" : (event.location || "").trim(), url: safeUrl(component.getFirstPropertyValue("url")) });
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

// These general student-service feeds are an allowlist, not a campus-wide
// event search. Exclude explicit audience restrictions without treating a
// speaker's degree or a mention of a program as an attendance restriction.
export function departmentEventEligible(event) {
  const title = event.title || "";
  const text = `${title}\n${event.description || ""}`.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const program = "(?:JCT\\s+MBA|MBA|M\\.?Eng\\.?|LL\\.?M\\.?|Ph\\.?D\\.?|doctoral|undergraduate)";
  if (new RegExp(`^\\s*${program}(?:\\s|:|[-–—])`, "i").test(title)) return false;
  if (new RegExp(`\\b(?:for|restricted to|limited to|exclusively for)\\s+(?:the\\s+)?${program}\\s+(?:students|candidates)\\b`, "i").test(text)) return false;
  if (new RegExp(`\\b${program}\\s+(?:students|candidates)\\s+(?:only|are invited)\\b`, "i").test(text)) return false;
  return !/\b(?:members|staff|faculty|invite|invitation)[\s-]+only(?=\s*(?:[.,;!?]|$)|\s+(?:event|meeting|session|workshop|audience|attendance|registration|gathering|reception|dinner|lunch|retreat)\b)/i.test(text)
    && !/\b(?:admissions|prospective student|research seminar|dissertation defense)\b/i.test(title);
}

const textContent = node => node.nodeName === "#text" ? node.value : (node.childNodes || []).map(textContent).join("");
function findNodes(root, predicate) {
  const found = [];
  const visit = node => { if (predicate(node)) found.push(node); (node.childNodes || []).forEach(visit); };
  visit(root);
  return found;
}
const hasClass = (node, name) => node.attrs?.some(a => a.name === "class" && a.value.split(/\s+/).includes(name));

// Supplement the Registrar with Tech-only dates. Shared breaks, exam periods,
// deadlines and continuing-student enrollment stay in the Registrar source.
export function parseTechAcademic(html) {
  const document = parse(html);
  const blocks = findNodes(document, n => /^h[1-6]$/.test(n.tagName) || n.tagName === "table");
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const events = [];
  let term;
  let tables = 0;
  const occurrences = new Map();
  for (const block of blocks) {
    if (block.tagName !== "table") {
      const match = textContent(block).trim().match(/^(Fall|Spring|Summer|Winter)\s+(\d{4})$/i);
      if (match) term = { name: match[1].toLowerCase(), year: Number(match[2]) };
      continue;
    }
    if (!term) continue;
    tables++;
    for (const row of findNodes(block, n => n.tagName === "tr")) {
      const cells = findNodes(row, n => n.tagName === "td").map(n => textContent(n).replace(/\s+/g, " ").trim());
      if (cells.length < 2) continue;
      const [dates, description] = cells;
      const maker = /^Maker Day\b/i.test(description);
      const newEnrollment = /^Pre-?\s*enrollment for new admits\b/i.test(description);
      if (!maker && !newEnrollment) continue;
      const datesFound = [...dates.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\b/gi)];
      if (!datesFound.length || datesFound.length > 2) throw new Error("Tech academic date format changed");
      // Require a month for each endpoint, so an unrecognized range cannot
      // silently collapse into a single day.
      if (/[–—-]/.test(dates) && datesFound.length !== 2) throw new Error("Tech academic date range changed");
      const days = datesFound.map(match => {
        const month = months.findIndex(m => m.toLowerCase() === match[1].toLowerCase()) + 1;
        const day = `${term.year}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
        if (new Date(day).toISOString().slice(0, 10) !== day) throw new Error("Invalid Tech academic date");
        return day;
      });
      const times = [...description.matchAll(/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi)];
      if (newEnrollment && times.length !== 2) throw new Error("Tech enrollment opening/closing times missing");
      const timed = (day, time) => {
        const hour = Number(time[1]), minute = Number(time[2]);
        if (hour < 1 || hour > 12 || minute > 59) throw new Error("Invalid Tech enrollment time");
        return wallTime(`${day}T${String(hour % 12 + (/pm/i.test(time[3]) ? 12 : 0)).padStart(2, "0")}:${time[2]}:00`);
      };
      const start = maker ? days[0] : timed(days[0], times[0]);
      const end = maker ? addDay(days.at(-1)) : timed(days.at(-1), times[1]);
      if (end < start) throw new Error("Invalid Tech academic range");
      const label = maker ? "Maker Day" : "New-student pre-enrollment";
      const key = `${term.name}:${term.year}:${label}`;
      const occurrence = (occurrences.get(key) || 0) + 1;
      occurrences.set(key, occurrence);
      events.push({ id: `tech-academic:${key}:${occurrence}`, source: "tech-academic", category: "Academic dates", title: `Cornell Tech: ${label}`, start, end, allDay: maker, description, location: "", url: TECH_ACADEMIC_URL });
    }
  }
  if (!tables) throw new Error("Tech academic term table not found");
  return { events };
}

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
      || (semester && /term begins|(?:regular|full|7 week [12] session) instruction begins|last day of instruction.*(?:regular|full|7 week [12])|final exams|study (?:days|period)/i.test(title))
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
  const department = DEPARTMENT_SOURCES.find(source => source.id === id);
  if (department) return { events: parseICS(await (await get(department.url, {}, fetcher)).text(), windowFor(now), id) };
  if (id === "academic") return parseAcademicResponse(await get(ACADEMIC_URL, {}, fetcher));
  if (id === "tech-academic") return parseTechAcademic(await (await get(TECH_ACADEMIC_URL, { redirect: "follow", headers: { "User-Agent": "CTSG-Calendar/1.0", Accept: "text/html,application/json" } }, fetcher)).text());
  if (id === "clubs") return loadNotion(env, fetcher);
  throw new Error("Unknown calendar source");
}
