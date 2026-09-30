import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ICAL from "ical.js";
import { parseICS, parseAcademic, parseTechAcademic, ACADEMIC_URL, TECH_ACADEMIC_URL, STUDENT_AFFAIRS_URL, INCLUSION_URL, CAREERS_URL, STUDENT_SOURCES, loadStudentSource, departmentEventEligible, notionEvent, loadNotion } from "../calendar/sources.mjs";
import worker, { CalendarProcessor } from "../calendar/worker.mjs";
import { calendarData, memoryStorage, toICS } from "../calendar/service.mjs";
import { dateKey, lastDay, eventsOnDay, eventFilter, calendarRange } from "../public/calendar.js";

const window = { start: "2026-01-01", end: "2028-01-01" };
const ics = (...events) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap(lines => ["BEGIN:VEVENT", ...lines, "END:VEVENT"]), "END:VCALENDAR", ""].join("\r\n");
const page = (approval = "Approved", date = { start: "2026-10-10", end: "2026-10-13" }) => ({ id: "club-event", properties: {
  "Approval status": { status: { name: approval } },
  "Event Title": { title: [{ plain_text: "Club picnic" }] },
  Date: { date },
  Description: { rich_text: [{ plain_text: "Public description" }] },
  "Private notes": { rich_text: [{ plain_text: "do not publish" }] },
  "RSVP/details URL": { url: "javascript:alert(1)" },
} });

test("ICS converts New York time across DST and keeps stable IDs after rescheduling", () => {
  const source = start => ics(["UID:one", "SUMMARY:Meetup", `DTSTART;TZID=America/New_York:${start}`, "DURATION:PT1H"]);
  const first = parseICS(source("20261028T120000"), window)[0];
  const moved = parseICS(source("20261118T120000"), window)[0];
  assert.equal(first.start, "2026-10-28T16:00:00.000Z");
  assert.equal(moved.start, "2026-11-18T17:00:00.000Z");
  assert.equal(first.id, moved.id);
  assert.equal(moved.end, "2026-11-18T18:00:00.000Z");
});

test("ICS applies recurrence moves, exclusions, and cancellations", () => {
  const events = parseICS(ics(
    ["UID:series", "SUMMARY:Weekly", "DTSTART:20261001T160000Z", "DTEND:20261001T170000Z", "RRULE:FREQ=WEEKLY;COUNT=5", "EXDATE:20261008T160000Z"],
    ["UID:series", "RECURRENCE-ID:20261015T160000Z", "SUMMARY:Moved", "DTSTART:20261016T180000Z", "DTEND:20261016T190000Z"],
    ["UID:series", "RECURRENCE-ID:20261022T160000Z", "SUMMARY:Cancelled", "DTSTART:20261022T160000Z", "DTEND:20261022T170000Z", "STATUS:CANCELLED"],
    ["UID:cancelled", "SUMMARY:Cancelled standalone", "DTSTART;VALUE=DATE:20261002", "STATUS:CANCELLED"],
  ), window);
  assert.deepEqual(events.map(e => [e.title, e.start]), [
    ["Weekly", "2026-10-01T16:00:00.000Z"], ["Moved", "2026-10-16T18:00:00.000Z"], ["Weekly", "2026-10-29T16:00:00.000Z"],
  ]);
  assert.match(events[1].id, /2026-10-15/);
});

test("Notion publication requires explicit approval and excludes private fields", () => {
  for (const status of ["Pending", "Rejected", "", "approved"]) assert.equal(notionEvent(page(status)), null);
  assert.equal(notionEvent({ ...page(), archived: true }), null);
  const cancelled = page(); cancelled.properties["Event status"] = { select: { name: "Cancelled" } };
  assert.equal(notionEvent(cancelled), null);
  const approved = notionEvent(page());
  assert.equal(approved.end, "2026-10-14");
  assert.equal(approved.url, "");
  assert.ok(!JSON.stringify(approved).includes("do not publish"));
  assert.equal(notionEvent(page("Approved", { start: "2026-11-18T12:00:00", time_zone: "America/New_York" })).start, "2026-11-18T17:00:00.000Z");
});

test("official department imports exclude explicit narrow audiences", () => {
  for (const event of [
    { title: "JCT MBA NYC Excursion: Mets Game" },
    { title: "(Nearly) End of Summer Celebration", description: "JCT MBA Students are invited to celebrate." },
    { title: "Meet the program team", description: "This session is for PhD students." },
    { title: "Planning lunch", description: "Invitation-only meeting." },
    { title: "Admissions Student Ambassador Program" },
    { title: "Research seminar: Specialized methods" },
  ]) assert.equal(departmentEventEligible(event), false, event.title);
  for (const event of [
    { title: "Bagels and Belonging", description: "Meet the Inclusion and Belonging team at the Masters Studio." },
    { title: "Send a Post Card!", description: "Students can write to friends and family." },
    { title: "Visas After Graduation", description: "Learn about options for international students." },
    { title: "Career workshop", description: "Open to all students. Our speaker earned an MBA." },
    { title: "Bloomberg Center Art Tour", description: "Some art is in faculty/staff-only spaces, so we are offering a tour for students." },
    { title: "Town hall" },
  ]) assert.equal(departmentEventEligible(event), true, event.title);
});

const studentSource = STUDENT_SOURCES.find(s => s.department === "career-management");
const privateURL = "https://cornelltech.campusgroups.com/ics?uid=secret-token&type=group&eid=department";
const studentEnv = { [studentSource.secret]: privateURL };
const studentEvent = (uid, title, tags = ["All Master's Students"], acronym = "CTCAREERS") => [
  `UID:${uid}`, `SUMMARY:${title}`, "DTSTART:20261007T170000Z", "DURATION:PT1H",
  `CATEGORIES;X-CG-CATEGORY=club_acronym:${acronym}`,
  ...tags.map(tag => `CATEGORIES;X-CG-CATEGORY=event_tags:${tag}`),
  "DESCRIPTION:Private joining link https://meeting.example/private-join",
  "LOCATION:Private room", "URL:https://cornelltech.campusgroups.com/rsvp?id=123&private=hidden",
];

test("student exports enforce department and audience eligibility and minimize published fields", async () => {
  const input = ics(
    studentEvent("all", "Campus career workshop"),
    studentEvent("technical", "Technical career fair", ["Technical Programs"]),
    studentEvent("mba", "Summer social", ["JCTMBA'27"]),
    studentEvent("unknown", "Unclassified career session", []),
    studentEvent("club", "Club workshop", ["All Master's Students"], "CHESS"),
    studentEvent("invite", "Bloomberg INVITATION ONLY"),
    studentEvent("cancelled", "(POSTPONED) Career workshop"),
  );
  const { events } = await loadStudentSource(studentSource, studentEnv, async () => new Response(input), new Date("2026-09-30"));
  assert.deepEqual(events.map(e => e.id), ["career-management:all"]);
  assert.equal(events[0].url, "https://cornelltech.campusgroups.com/rsvp?id=123");
  assert.doesNotMatch(JSON.stringify(events), /private-join|Private room|private=|secret-token/);
  const parsed = parseICS(input, window);
  assert.equal(departmentEventEligible(parsed.find(e => e.title === "Summer social")), false);
  assert.equal(departmentEventEligible(parsed.find(e => e.title === "Technical career fair")), false);
});

test("student exports reject wrong hosts, redirects, and redact fetch or parser errors", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error(`Failure at ${privateURL}`); };
  await assert.rejects(loadStudentSource(studentSource, { [studentSource.secret]: privateURL.replace("cornelltech.campusgroups.com", "example.com") }, fetcher), /^Error: Student subscription could not be refreshed \(configuration\)$/);
  assert.equal(calls, 0);
  await assert.rejects(loadStudentSource(studentSource, studentEnv, fetcher), /^Error: Student subscription could not be refreshed \(download\)$/);
  await assert.rejects(loadStudentSource(studentSource, studentEnv, async (url, options) => {
    assert.equal(options.redirect, "manual");
    return new Response(`Not a calendar ${privateURL}`);
  }), /^Error: Student subscription could not be refreshed \(calendar parsing\)$/);
});

test("student exports follow same-site redirects without forwarding credentials to other hosts", async () => {
  const calls = [];
  const result = await loadStudentSource(studentSource, studentEnv, async url => {
    calls.push(url);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: "/ics?canonical=1" } }) : new Response(ics(studentEvent("redirected", "Career workshop")));
  }, new Date("2026-09-30"));
  assert.equal(result.events.length, 1);
  assert.equal(calls[1], "https://cornelltech.campusgroups.com/ics?canonical=1");
  let blockedCalls = 0;
  await assert.rejects(loadStudentSource(studentSource, studentEnv, async () => {
    blockedCalls++;
    return new Response(null, { status: 302, headers: { Location: "https://example.com/?secret-token" } });
  }), /^Error: Student subscription could not be refreshed \(redirect\)$/);
  assert.equal(blockedCalls, 1);
});

test("student and public exports deduplicate identities, while secrets stay out of output and storage", async () => {
  const storage = memoryStorage();
  const now = new Date("2026-09-30T12:00:00Z");
  const input = ics(studentEvent("same", "Career workshop"));
  const fetcher = async url => {
    if (url === ACADEMIC_URL) return new Response(academicHTML);
    if (url === TECH_ACADEMIC_URL) return new Response(techAcademicHTML);
    return new Response([privateURL, CAREERS_URL].includes(url) ? input : ics());
  };
  const data = await calendarData(studentEnv, storage, { now, fetcher });
  assert.equal(data.events.filter(e => e.id === "career-management:same").length, 1);
  assert.equal(data.sources.find(s => s.id === studentSource.id).state, "current");
  for (const output of [JSON.stringify(data), toICS(data), JSON.stringify(await storage.get(`calendar-v1:${studentSource.id}`))]) assert.doesNotMatch(output, /secret-token|private-join|Private room|private=hidden/);
  const disabled = await calendarData({}, storage, { now, fetcher });
  assert.ok(!disabled.sources.some(s => s.id === studentSource.id));
});

test("student subscription cache expires on loss of access and clears after a valid empty export", async () => {
  const storage = memoryStorage();
  const key = `calendar-v1:${studentSource.id}`;
  const events = (await loadStudentSource(studentSource, studentEnv, async () => new Response(ics(studentEvent("one", "Career workshop"))), new Date("2026-09-30"))).events;
  await storage.put(key, JSON.stringify({ updatedAt: "2026-09-30T12:00:00Z", events }));
  const offline = async () => { throw new Error("Unavailable"); };
  const recent = await calendarData(studentEnv, storage, { now: new Date("2026-09-30T12:30:00Z"), fetcher: offline });
  assert.equal(recent.events.length, 1);
  const expired = await calendarData(studentEnv, storage, { now: new Date("2026-09-30T13:01:00Z"), fetcher: offline });
  assert.equal(expired.events.length, 0);
  assert.doesNotMatch(JSON.stringify(expired), /secret-token/);
  const disabled = await calendarData({}, storage, { now: new Date("2026-09-30T12:01:00Z"), fetcher: offline });
  assert.equal(disabled.events.length, 0);
  const cleared = await calendarData(studentEnv, storage, { now: new Date("2026-09-30T12:30:00Z"), fetcher: async url => { if (url === privateURL) return new Response(ics()); throw new Error("Unavailable"); } });
  assert.equal(cleared.events.length, 0);
  assert.deepEqual((await storage.get(key)).events, []);
});

test("additional department keeps separate IDs and filtered cache during outages", async () => {
  const input = ics(["UID:community", "SUMMARY:Bagels and Belonging", "DTSTART:20261001T130000Z", "DURATION:PT1H"]);
  const event = parseICS(input, window, "inclusion-belonging")[0];
  assert.equal(event.source, "inclusion-belonging");
  assert.equal(eventFilter(event), "inclusion-belonging");
  assert.notEqual(event.id, parseICS(input, window)[0].id);
  const storage = memoryStorage();
  await storage.put("calendar-v1:inclusion-belonging", JSON.stringify({ updatedAt: "2026-09-29T12:00:00Z", events: [event, { ...event, id: "restricted", title: "MBA welcome session" }] }));
  const data = await calendarData({}, storage, { now: new Date("2026-09-30T12:00:00Z"), fetcher: async () => { throw new Error("Source outage"); } });
  assert.deepEqual(data.events.map(e => e.id), [event.id]);
  assert.equal(data.sources.find(s => s.id === "inclusion-belonging").state, "stale");
});

test("club and CTSG events filter independently without bypassing approval", () => {
  const club = page();
  club.properties["Club Name"] = { rich_text: [{ plain_text: "Chess Club" }] };
  const ctsg = page();
  ctsg.properties["Event type"] = { select: { name: "CTSG" } };
  const events = [notionEvent(club), notionEvent(ctsg)];
  assert.equal(events[1].category, "CTSG events");
  assert.deepEqual(events.filter(e => new Set(["clubs"]).has(eventFilter(e))), [events[0]]);
  assert.deepEqual(events.filter(e => new Set(["ctsg"]).has(eventFilter(e))), [events[1]]);
  assert.equal(eventFilter({ source: "student-affairs", category: "School events" }), "student-affairs");
  for (const name of ["CTSG", " cornell tech student government "]) {
    const event = page(); event.properties["Club Name"] = { rich_text: [{ plain_text: name }] };
    assert.equal(eventFilter(notionEvent(event)), "ctsg");
    event.properties["Event type"] = { select: { name: "Clubs" } };
    assert.equal(eventFilter(notionEvent(event)), "clubs");
  }
  ctsg.properties["Approval status"].status.name = "Pending";
  assert.equal(notionEvent(ctsg), null);
});

test("Notion queries all approved pages and fails on incomplete pagination", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    if (!url.endsWith("/query")) return Response.json({ properties: { "Approval status": { type: "status" } } });
    const body = JSON.parse(options.body); calls.push(body);
    return Response.json(body.start_cursor ? { results: [{ ...page(), id: "second" }], has_more: false } : { results: [page()], has_more: true, next_cursor: "cursor" });
  };
  const data = await loadNotion({ NOTION_TOKEN: "test" }, fetcher);
  assert.equal(data.events.length, 2);
  assert.deepEqual(calls[0].filter, { property: "Approval status", status: { equals: "Approved" } });
  assert.equal(calls[1].start_cursor, "cursor");
  await assert.rejects(loadNotion({ NOTION_TOKEN: "test" }, async url => Response.json(url.endsWith("/query") ? { results: [], has_more: true } : { properties: { "Approval status": { type: "select" } } })), /cursor/);
  await assert.rejects(loadNotion({ NOTION_TOKEN: "test" }, async () => Response.json({ properties: {} })), /Approval status/);
});

const academicHTML = readFileSync(new URL("./fixtures/registrar-academic.html", import.meta.url), "utf8");
const techAcademicHTML = readFileSync(new URL("./fixtures/tech-academic.html", import.meta.url), "utf8");

test("Tech calendar supplements Maker Days and new-admit enrollment without duplicating Registrar dates", () => {
  const events = parseTechAcademic(techAcademicHTML).events;
  assert.equal(events.length, 5);
  assert.deepEqual(events.filter(e => /Maker Day/.test(e.title)).map(e => [e.start, e.end]), [
    ["2026-09-25", "2026-09-26"], ["2026-10-16", "2026-10-17"],
    ["2026-11-13", "2026-11-14"], ["2026-12-04", "2026-12-05"],
  ]);
  const enrollment = events.find(e => /pre-enrollment/.test(e.title));
  assert.equal(enrollment.start, "2026-07-22T13:00:00.000Z");
  assert.equal(enrollment.end, "2026-07-23T20:00:00.000Z");
  assert.equal(enrollment.allDay, false);
  assert.ok(events.every(e => e.url === TECH_ACADEMIC_URL && eventFilter(e) === "academic"));
  assert.ok(events.every(e => !/Break|Final exams|Spring 2027/.test(e.title)));
});

test("Tech dates follow semester headings across years and retain IDs after a date correction", () => {
  const future = parseTechAcademic(techAcademicHTML.replace(/2026/g, "2030")).events;
  assert.ok(future.every(e => e.start.startsWith("2030")));
  const original = parseTechAcademic(techAcademicHTML).events;
  const moved = parseTechAcademic(techAcademicHTML.replace("October 16", "October 17")).events;
  assert.deepEqual(moved.map(e => e.id), original.map(e => e.id));
  assert.equal(moved.find(e => e.start === "2026-10-17").end, "2026-10-18");
  const spring = parseTechAcademic(techAcademicHTML + '<h2>SPRING 2027</h2><table><tr><td>Friday, February 12</td><td>Maker Day</td></tr></table>').events;
  assert.equal(spring.at(-1).start, "2027-02-12");
});

test("malformed Tech calendar dates and missing enrollment times fail closed", () => {
  assert.throws(() => parseTechAcademic("<h1>Maintenance</h1>"), /term table/);
  assert.throws(() => parseTechAcademic(techAcademicHTML.replace("October 16", "October 32")));
  assert.throws(() => parseTechAcademic(techAcademicHTML.replace("October 16", "TBD")), /format/);
  assert.throws(() => parseTechAcademic(techAcademicHTML.replace("9:00am", "TBD")), /times/);
});

test("Registrar imports exams and Tech enrollment while excluding undergraduate openings", () => {
  const { events, academicYear } = parseAcademic(academicHTML);
  assert.equal(academicYear, "2026–2027");
  assert.deepEqual(events.filter(e => /final exams/i.test(e.title)).map(e => [e.start, e.end, e.allDay]), [
    ["2026-10-15", "2026-10-23", true], ["2026-12-11", "2026-12-20", true],
    ["2027-03-17", "2027-03-25", true], ["2027-05-15", "2027-05-23", true],
  ]);
  assert.ok(events.some(e => /Last day to add.*7 week 1/.test(e.title)));
  assert.ok(events.some(e => /Last day to change grading basis.*regular/.test(e.title)));
  assert.ok(events.some(e => /Last day of instruction.*7 week 1/.test(e.title) && e.start === "2026-10-09"));
  assert.ok(events.some(e => /7 week 2 session instruction begins/.test(e.title) && e.start === "2026-10-14"));
  assert.ok(events.some(e => /Last day of instruction.*7 week 2/.test(e.title) && e.start === "2026-12-04"));
  assert.ok(events.every(e => !/Seniors|Juniors|Sophomores|begins for First-Years|grade deadline|internal transfer/.test(e.title)));
  assert.ok(events.every(e => e.url === ACADEMIC_URL));
  assert.equal(events.find(e => e.title === "Spring Break/No classes").end, "2027-04-05");
});

test("Registrar preserves enrollment opening times and deadlines across daylight saving", () => {
  const events = parseAcademic(academicHTML).events;
  const august = events.find(e => /Fall.*Add\/Drop/.test(e.title));
  assert.equal(august.start, "2026-08-17T13:00:00.000Z");
  assert.equal(august.end, august.start);
  const november = events.find(e => /Enrollment begins/.test(e.title));
  assert.equal(november.start, "2026-11-10T12:30:00.000Z");
  assert.equal(november.end, "2026-11-13T04:59:00.000Z");
  assert.equal(lastDay(november), "2026-11-12");
  const deadline = events.find(e => /Fall.*grading basis.*7 week 2/.test(e.title));
  assert.equal(deadline.start, "2026-11-12T04:59:00.000Z");
  assert.equal(deadline.allDay, false);
});

test("the permanent Registrar page can roll to a future academic year without code changes", () => {
  const nextYear = academicHTML.replace(/2026/g, "2030").replace(/2027/g, "2031");
  const result = parseAcademic(nextYear);
  assert.equal(result.academicYear, "2030–2031");
  assert.equal(result.events.find(e => /Fall.*Add\/Drop/.test(e.title)).start.slice(0, 10), "2030-08-17");
  assert.equal(result.events.find(e => e.title === "Spring Break/No classes").end, "2031-04-05");
  assert.ok(result.events.every(e => e.start.startsWith("2030") || e.start.startsWith("2031")));
});

test("rescheduled Registrar events retain ICS identity and malformed pages fail closed", () => {
  const original = parseAcademic(academicHTML).events.find(e => /Fall.*Add\/Drop/.test(e.title));
  const moved = parseAcademic(academicHTML.replace("Aug 17", "Aug 18")).events.find(e => /Fall.*Add\/Drop/.test(e.title));
  assert.equal(moved.id, original.id);
  assert.notEqual(moved.start, original.start);
  assert.throws(() => parseAcademic("<h1>Maintenance</h1>"), /year/);
  assert.throws(() => parseAcademic(academicHTML.replace("Aug 17", "Aug TBD")), /format/);
  assert.throws(() => parseAcademic(academicHTML.replace("Aug 17", "Aug 32")));
  assert.throws(() => parseAcademic(academicHTML.replace("9:00 AM", "TBD")), /time format/);
});

test("scheduled refresh updates persistent JSON and ICS without any visitor request", async t => {
  const storage = memoryStorage();
  let html = academicHTML;
  const fetched = [];
  t.mock.method(globalThis, "fetch", async url => {
    fetched.push(url);
    if (url === ACADEMIC_URL) return new Response(html);
    if (url === TECH_ACADEMIC_URL) return new Response(techAcademicHTML);
    if ([STUDENT_AFFAIRS_URL, INCLUSION_URL, CAREERS_URL].includes(url)) return new Response(ics());
    throw new Error(`Unexpected source ${url}`);
  });
  const env = { CALENDAR_CACHE: storage };
  const processor = new CalendarProcessor({}, env);
  env.CALENDAR_PROCESSOR = { idFromName: name => name, get: () => processor };
  const trigger = { scheduledTime: Date.parse("2026-09-29T12:00:00Z") };
  await worker.scheduled(trigger, env);
  assert.equal((await storage.get("calendar-v1:academic")).academicYear, "2026–2027");
  assert.deepEqual(new Set(fetched), new Set([ACADEMIC_URL, TECH_ACADEMIC_URL, STUDENT_AFFAIRS_URL, INCLUSION_URL, CAREERS_URL]));
  html = academicHTML.replace("Aug 17", "Aug 18");
  await worker.scheduled(trigger, env);
  assert.equal(fetched.length, 10); // Scheduled refresh bypasses even a fresh cache, including empty Career feeds.
  const refreshed = await calendarData(env, storage, { now: new Date(trigger.scheduledTime) });
  const exported = new ICAL.Component(ICAL.parse(toICS(refreshed))).getAllSubcomponents("vevent");
  const enrollment = exported.find(c => /Fall.*Add\/Drop/.test(c.getFirstPropertyValue("summary")));
  assert.equal(enrollment.getFirstPropertyValue("dtstart").toString(), "2026-08-18T13:00:00Z");
  const saved = await storage.get("calendar-v1:academic");
  html = "<h1>Temporary outage</h1>";
  await assert.rejects(worker.scheduled(trigger, env), /Cornell academic dates/);
  assert.deepEqual(await storage.get("calendar-v1:academic"), saved);
});

test("public Worker cannot expose the internal force-refresh route", async () => {
  let calls = 0;
  const env = { CALENDAR_PROCESSOR: { idFromName: name => name, get: () => ({ fetch: async request => { calls++; return new Response(new URL(request.url).pathname); } }) } };
  for (const method of ["GET", "POST"]) {
    const response = await worker.fetch(new Request("https://calendar.example/refresh", { method }), env);
    assert.equal(response.status, method === "GET" ? 404 : 405);
  }
  assert.equal(calls, 0);
  for (const path of ["/api/calendar", "/api/calendar.ics"]) {
    assert.equal(await (await worker.fetch(new Request(`https://calendar.example${path}`), env)).text(), path);
  }
  assert.equal(calls, 2);
});

test("simultaneous calendar requests share one refresh through the processor", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async url => {
    calls++;
    if (url === ACADEMIC_URL) return new Response(academicHTML);
    if (url === TECH_ACADEMIC_URL) return new Response(techAcademicHTML);
    if ([STUDENT_AFFAIRS_URL, INCLUSION_URL, CAREERS_URL].includes(url)) return new Response(ics());
    throw new Error(`Unexpected source ${url}`);
  });
  const processor = new CalendarProcessor({}, { CALENDAR_CACHE: memoryStorage() });
  const responses = await Promise.all(["/api/calendar", "/api/calendar.ics"].map(path => processor.fetch(new Request(`https://calendar.example${path}`))));
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(calls, 5);
});

test("source outages preserve public cache but expire club approvals after one hour", async () => {
  const storage = memoryStorage();
  const event = notionEvent(page());
  const saved = { updatedAt: "2026-09-28T12:00:00Z", events: [event] };
  await storage.put("calendar-v1:clubs", JSON.stringify(saved));
  await storage.put("calendar-v1:student-affairs", JSON.stringify({ ...saved, events: [{ ...event, id: "school", source: "student-affairs" }] }));
  const failedFetch = async () => { throw new Error("Simulated source outage"); };
  const fresh = await calendarData({ NOTION_TOKEN: "test" }, storage, { now: new Date("2026-09-28T12:10:00Z"), fetcher: failedFetch });
  assert.equal(fresh.sources.find(s => s.id === "clubs").state, "current");
  const partial = await calendarData({ NOTION_TOKEN: "test" }, storage, { now: new Date("2026-09-28T12:30:00Z"), fetcher: failedFetch });
  assert.equal(partial.events.length, 2);
  const expired = await calendarData({ NOTION_TOKEN: "test" }, storage, { now: new Date("2026-09-28T13:01:00Z"), fetcher: failedFetch });
  assert.deepEqual(expired.events.map(e => e.id), ["school"]);
  const disabled = await calendarData({}, storage, { now: new Date("2026-09-28T12:10:00Z"), fetcher: failedFetch });
  assert.ok(disabled.events.every(e => e.source !== "clubs"));
});

test("successful refresh removes withdrawn approvals instead of accumulating records", async () => {
  const storage = memoryStorage();
  await storage.put("calendar-v1:clubs", JSON.stringify({ updatedAt: "2026-09-28T12:00:00Z", events: [notionEvent(page())] }));
  const data = await calendarData({ NOTION_TOKEN: "test" }, storage, { now: new Date("2026-09-28T12:20:00Z"), fetcher: async url => {
    if (!url.startsWith("https://api.notion.com")) throw new Error("Unrelated source unavailable");
    return Response.json(url.endsWith("/query") ? { results: [], has_more: false } : { properties: { "Approval status": { type: "status" } } });
  } });
  assert.equal(data.sources.find(s => s.id === "clubs").state, "current");
  assert.deepEqual(data.events, []);
});

test("all-day end dates and New York midnight render on the correct days", () => {
  const event = notionEvent(page());
  assert.equal(eventsOnDay([event], "2026-10-13").length, 1);
  assert.equal(eventsOnDay([event], "2026-10-14").length, 0);
  assert.equal(dateKey("2026-10-01T02:00:00Z"), "2026-09-30");
  const timed = { start: "2026-11-01T03:00:00Z", end: "2026-11-01T04:00:00Z", allDay: false };
  assert.equal(eventsOnDay([timed], "2026-11-01").length, 0);
});

test("week ranges include both months across year and DST boundaries", () => {
  const yearBoundary = calendarRange(new Date("2027-01-01T00:00:00Z"), "week");
  assert.equal(yearBoundary.start.toISOString(), "2026-12-27T00:00:00.000Z");
  assert.equal(yearBoundary.end.toISOString(), "2027-01-03T00:00:00.000Z");
  const dstWeek = calendarRange(new Date("2026-11-01T00:00:00Z"), "week");
  assert.equal(dstWeek.end.toISOString(), "2026-11-08T00:00:00.000Z");
  const month = calendarRange(new Date("2027-01-01T00:00:00Z"), "month");
  assert.equal(month.start.toISOString(), "2027-01-01T00:00:00.000Z");
  assert.equal(month.end.toISOString(), "2027-02-01T00:00:00.000Z");
});

test("ICS export round-trips Unicode, escaped text and all-day ranges", () => {
  const event = { ...notionEvent(page()), title: "🍂; Picnic, welcome ".repeat(10), description: "Line one\nLine two\\end" };
  const output = toICS({ generatedAt: "2026-09-28T12:00:00.000Z", events: [event] });
  assert.ok(output.split("\r\n").every(line => Buffer.byteLength(line) <= 75));
  const result = new ICAL.Event(new ICAL.Component(ICAL.parse(output)).getFirstSubcomponent("vevent"));
  assert.equal(result.summary, event.title);
  assert.equal(result.description, event.description);
  assert.equal(result.endDate.toString(), "2026-10-14");
  assert.equal(result.startDate.isDate, true);
  const instant = notionEvent(page("Approved", { start: "2026-10-01T12:00:00-04:00" }));
  assert.ok(!toICS({ generatedAt: "2026-09-28T12:00:00.000Z", events: [instant] }).includes("DTEND"));
});

test("rolling calendar starts today and includes exactly seven dates across boundaries", () => {
  for (const [today, afterLastDay] of [
    ["2026-09-28", "2026-10-05"],
    ["2026-12-29", "2027-01-05"],
    ["2026-10-30", "2026-11-06"],
  ]) {
    const range = calendarRange(new Date(`${today}T00:00:00Z`), "rolling");
    assert.equal(range.start.toISOString().slice(0, 10), today);
    assert.equal(range.end.toISOString().slice(0, 10), afterLastDay);
    assert.equal((range.end - range.start) / 86400000, 7);
  }
  const range = calendarRange(new Date(`${dateKey("2026-09-29T02:00:00Z")}T00:00:00Z`), "rolling");
  assert.equal(range.start.toISOString().slice(0, 10), "2026-09-28");
});
