import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTechEvents, parseTechEventDetail, parseTechEventsListing, techEventEligible } from "../calendar/tech-events.mjs";

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const listingData = JSON.parse(fixture("tech-events-listing.json"));
const [admissions, field, healthcare] = parseTechEventsListing(listingData);
const fieldDetail = fixture("tech-events-field.html");
const healthDetail = fixture("tech-events-healthcare.html");
const aapDate = fixture("tech-events-aap-date.html");
const gomryDate = fixture("tech-events-gomry-date.html");
const now = new Date("2026-09-30T12:00:00Z");
const responses = new Map([
  [field.url, fieldDetail], [healthcare.url, healthDetail],
  ["https://aap.cornell.edu/events/lecture/field-conditions-incubating-media-arts-in-nyc/", aapDate],
  ["https://www.gomry.com/event/Revolutionizing-Healthcare-With-AI-Powered-Devices-AIWeekNY-hcCSjFC5rRu2QM8d7ELH", gomryDate],
]);
function fakeFetch(overrides = new Map(), requests = []) {
  return async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
    const body = overrides.has(url) ? overrides.get(url) : new URL(url).pathname === "/wp-json/crn/filter/events" ? listingData : responses.get(url);
    assert.notEqual(body, undefined, `Unexpected URL: ${url}`);
    return body instanceof Response ? body : new Response(typeof body === "object" ? JSON.stringify(body) : body);
  };
}

test("imports current official events with verified years, New York times, and audience tags", async () => {
  const requests = [];
  const result = await loadTechEvents(fakeFetch(new Map(), requests), now);
  assert.equal(requests.length, 5);
  assert.deepEqual(result.diagnostics, { fetchedCount: 3, excludedCount: 1, importedCount: 2, pagesFetched: 1, failedCount: 0, issues: [] });
  assert.equal(result.events[0].title, "Field Conditions: Incubating Media Arts in NYC");
  assert.equal(result.events[0].start, "2026-09-30T23:00:00.000Z");
  assert.equal(result.events[0].end, "2026-10-01T00:30:00.000Z");
  assert.ok(result.events[0].audienceTags.includes("Master's Students"));
  assert.equal(result.events[1].start, "2026-10-08T16:00:00.000Z");
  assert.equal(result.events[1].end, "2026-10-08T18:00:00.000Z");
  assert.match(result.events[1].description, /digital health innovations/);
  assert.equal(result.events[1].location, "1300 York Ave, New York, NY");
});

test("archived events do not download their detail or organizer pages again", async () => {
  const requests = [];
  const archivedIds = new Set([`tech-events:${new URL(field.url).pathname.split("/").filter(Boolean).at(-1)}`]);
  const result = await loadTechEvents(fakeFetch(new Map(), requests), now, { archivedIds });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].title, "Revolutionizing Healthcare With AI-Powered Devices");
  assert.equal(requests.length, 3);
  assert.ok(!requests.includes(field.url));
  assert.ok(!requests.some(url => url.includes("aap.cornell.edu")));
  assert.equal(result.excludedCount, 1);
  assert.equal(result.failedCount, 0);
});

test("includes specialized students and public research, while excluding restricted and admissions-only audiences", () => {
  assert.equal(techEventEligible(admissions), false);
  assert.equal(techEventEligible(field), true); // Includes prospective and current students.
  assert.equal(techEventEligible({ title: "Research seminar", audienceTags: ["PhDs"] }), true);
  assert.equal(techEventEligible({ title: "MBA networking", audienceTags: ["MBA Students"] }), true);
  assert.equal(techEventEligible({ title: "Admissions volunteer training", audienceTags: ["Master's Students"], eventTypes: ["Admissions"] }), true);
  assert.equal(techEventEligible({ title: "Research seminar", audienceTags: ["Faculty", "Staff"] }), false);
  assert.equal(techEventEligible({ title: "Research seminar", audienceTags: ["Faculty only", "Public"] }), false);
  assert.equal(techEventEligible({ title: "Talk", audienceTags: ["Invitation Only", "Master's Students"] }), false);
  assert.equal(techEventEligible({ title: "Cancelled talk", audienceTags: ["Public"] }), false);
  assert.equal(techEventEligible({ title: "Admissions Student Ambassador Program", audienceTags: ["Public"] }), true);
  const restricted = healthDetail.replace("You are invited to join", "This is an invitation-only event. You are invited to join");
  assert.deepEqual(parseTechEventDetail(restricted, healthcare, gomryDate), { excluded: true });
});

test("never uses publication year or current year to fill in an event date", () => {
  const published = '<script type="application/ld+json">{"@type":"WebPage","datePublished":"2026-09-25T15:01:10Z"}</script>';
  const result = parseTechEventDetail(published + healthDetail, healthcare, "<time>October 8, 2026</time>");
  assert.equal(result.event, undefined);
  assert.match(result.organizerUrl, /gomry/);
});

test("rejects mismatched dates and malformed calendars instead of returning a silent empty source", () => {
  assert.throws(() => parseTechEventDetail(healthDetail, healthcare, gomryDate.replaceAll("2026-10-08", "2026-10-09")), /dates disagree/);
  assert.throws(() => parseTechEventDetail(healthDetail, healthcare, gomryDate.replace("T16:00:00", "T15:00:00")), /times disagree/);
  assert.throws(() => parseTechEventsListing({ html: "<p>Service temporarily unavailable</p>", count: 2, total: 2, totalPages: 1 }), /count/);
  assert.throws(() => parseTechEventsListing({ html: "", count: 0, total: 0 }), /pagination/);
  assert.throws(() => parseTechEventDetail("<p>Service temporarily unavailable</p>", healthcare), /detail section/);
});

test("uses declared zero totals for a legitimate empty source", async () => {
  const empty = async () => new Response(JSON.stringify({ html: "", count: 0, total: 0, totalPages: 0 }));
  const result = await loadTechEvents(empty, now);
  assert.deepEqual(result.events, []);
  assert.equal(result.diagnostics.fetchedCount, 0);
});

const card = (number, audience = "Prospective Students") => `<div class="event-filter-item"><span class="event-filter-item__day">Thu</span><span class="event-filter-item__month">10/08</span><a class="event-filter-item__title" href="https://tech.cornell.edu/events/event-${number}/">Event ${number}</a><span data-group="open_to">${audience}</span></div>`;
test("follows all API pages and verifies totals", async () => {
  const requests = [];
  const firstPage = { html: Array.from({ length: 100 }, (_, index) => card(index)).join(""), count: 100, total: 101, totalPages: 2 };
  const lastPage = { html: card(100), count: 1, total: 101, totalPages: 2 };
  const result = await loadTechEvents(async (url, options) => {
    requests.push(url);
    assert.ok(options.signal);
    return new Response(JSON.stringify(new URL(url).searchParams.get("paged") === "1" ? firstPage : lastPage));
  }, now);
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[1]).searchParams.get("offset"), "100");
  assert.equal(result.diagnostics.fetchedCount, 101);
  assert.equal(result.diagnostics.excludedCount, 101);
  assert.equal(result.diagnostics.pagesFetched, 2);
});

test("rejects incomplete pages, pagination loops, and changed totals", async () => {
  const page = { html: card(1), count: 1, total: 101, totalPages: 2 };
  await assert.rejects(loadTechEvents(async () => new Response(JSON.stringify(page)), now), /repeated/);
  await assert.rejects(loadTechEvents(async url => new Response(JSON.stringify({ ...page, html: card(new URL(url).searchParams.get("paged")) })), now), /incomplete/);
  await assert.rejects(loadTechEvents(async url => new Response(JSON.stringify({ ...page, total: new URL(url).searchParams.get("paged") === "1" ? 101 : 102 })), now), /changed during pagination/);
});

test("publishes verified events while reporting unverified organizer dates, network failures, and unsupported redirects", async () => {
  const organizer = "https://www.gomry.com/event/Revolutionizing-Healthcare-With-AI-Powered-Devices-AIWeekNY-hcCSjFC5rRu2QM8d7ELH";
  for (const [body, expected] of [
    ["<p>Date TBD</p>", /no verified full date/],
    [new Response("", { status: 503 }), /HTTP 503/],
    [new Response("", { status: 302, headers: { Location: "http://127.0.0.1/internal" } }), /outside supported/],
  ]) {
    const result = await loadTechEvents(fakeFetch(new Map([[organizer, body]])), now);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].url, field.url);
    assert.equal(result.failedCount, 1);
    assert.equal(result.excludedCount, 1);
    assert.equal(result.warnings[0].code, "unverified-events");
    assert.equal(result.diagnostics.issues[0].url, healthcare.url);
    assert.match(result.diagnostics.issues[0].message, expected);
  }
});

test("propagates explicit cancellations and canonical registration links", () => {
  assert.deepEqual(parseTechEventDetail(healthDetail, healthcare, gomryDate.replace("EventScheduled", "EventCancelled")), { excluded: true });
  const linked = healthDetail.replace("</section>", '<a href="https://cornelltech.campusgroups.com/CTSAA/rsvp_boot?id=12345">Register</a></section>');
  assert.equal(parseTechEventDetail(linked, healthcare, gomryDate).event.registrationUrl, "https://cornelltech.campusgroups.com/rsvp?id=12345");
});

test("keeps date-only events as all-day and does not invent end times", () => {
  const timed = gomryDate.replace(',"endDate":"2026-10-08T18:00:00.000Z"', "");
  const point = parseTechEventDetail(healthDetail, { ...healthcare, hours: "" }, timed).event;
  assert.equal(point.start, point.end);
  const allDay = parseTechEventDetail(healthDetail, { ...healthcare, hours: "All day" }, timed.replace("2026-10-08T16:00:00.000Z", "2026-10-08")).event;
  assert.equal(allDay.start, "2026-10-08");
  assert.equal(allDay.end, "2026-10-09");
  assert.equal(allDay.allDay, true);
});
