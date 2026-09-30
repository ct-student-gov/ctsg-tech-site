import test from "node:test";
import assert from "node:assert/strict";
import { CalendarArchive } from "../calendar/archive.mjs";
import { SOURCES, calendarData, memoryStorage, toICS } from "../calendar/service.mjs";
import { CalendarProcessor } from "../calendar/worker.mjs";

const now = new Date("2026-09-30T12:00:00Z");
const event = (id = "past", overrides = {}) => ({
  id, source: "academic", category: "Academic calendar", title: "Past event",
  start: "2026-01-01", end: "2026-01-02", allDay: true,
  description: "Public details", location: "Campus", url: "https://example.org/event", ...overrides,
});

// The same storage instance survives replacement of the archive/processor,
// matching Durable Object storage's structured-value get/list/put contract.
function persistentStorage() {
  const records = new Map();
  return {
    writes: 0, reads: 0,
    async list({ prefix }) {
      this.reads++;
      return new Map([...records].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]));
    },
    async put(key, value) { this.writes++; records.set(key, structuredClone(value)); },
  };
}

async function freshCache() {
  const storage = memoryStorage();
  for (const source of SOURCES) await storage.put(`calendar-v1:${source.id}`, JSON.stringify({ updatedAt: now.toISOString(), events: [] }));
  return storage;
}
const offline = async () => { throw new Error("Source unavailable"); };

test("archive survives processor restarts without rewriting or refetching historical events", async () => {
  const durable = persistentStorage();
  const cache = await freshCache();
  const old = event();
  const upcoming = event("upcoming", { start: "2026-10-02", end: "2026-10-03" });
  await cache.put("calendar-v1:academic", JSON.stringify({ updatedAt: now.toISOString(), events: [old, upcoming] }));
  let archive = new CalendarArchive(durable);
  let data = await calendarData({}, cache, { now, archive, fetcher: offline });
  assert.equal(durable.writes, 1);
  assert.equal(durable.reads, 1);
  assert.deepEqual(data.events.map(item => item.id), ["past", "upcoming"]);
  assert.equal(data.window.start, old.start);
  assert.equal(data.sources.find(source => source.id === "academic").archivedCount, 1);
  assert.match(toICS(data), /UID:past@ctsg.tech.cornell.edu/);
  // The upstream snapshot can disappear entirely; the archive has its own
  // persistent storage and no ninety-day expiry.
  await cache.put("calendar-v1:academic", JSON.stringify({ updatedAt: now.toISOString(), events: [] }));
  archive = new CalendarArchive(durable);
  data = await calendarData({}, cache, { now, archive, fetcher: offline });
  assert.deepEqual(data.events.map(item => item.id), ["past"]);
  await calendarData({}, cache, { now, archive, fetcher: offline });
  assert.equal(durable.reads, 2); // Once per archive instance, not per request.
  assert.equal(durable.writes, 1);
  await archive.capture("academic", [event("past", { title: "Changed upstream", description: "Changed" })], now);
  assert.equal(archive.events("academic")[0].title, "Past event");
  assert.equal(durable.writes, 1);
});

test("only ended events are archived; source identities stay separate and values are copied", async () => {
  const durable = persistentStorage();
  const archive = new CalendarArchive(durable);
  const original = event();
  await archive.capture("academic", [original, event("ongoing", { end: "2026-10-01" }), event("invalid", { end: "bad date" })], now);
  original.title = "Mutated in caller";
  await archive.capture("tech-academic", [event()], now);
  assert.equal(archive.events("academic").length, 1);
  assert.equal(archive.events("academic")[0].title, "Past event");
  assert.equal(durable.writes, 2);
  assert.ok(archive.has("tech-academic", "past"));
});

test("all-day events finish at New York midnight, not UTC midnight", async () => {
  const archive = new CalendarArchive();
  const day = event("all-day", { start: "2026-09-29", end: "2026-09-30" });
  await archive.capture("academic", [day], new Date("2026-09-30T02:00:00Z"));
  assert.equal(archive.events("academic").length, 0);
  await archive.capture("academic", [day], new Date("2026-09-30T04:00:00Z"));
  assert.equal(archive.events("academic").length, 1);
});

test("a storage quota failure leaves the live cache intact and capture retries next time", async () => {
  const durable = persistentStorage();
  const put = durable.put.bind(durable);
  durable.put = async () => { throw new Error("Archive write quota exceeded"); };
  const archive = new CalendarArchive(durable);
  const cache = await freshCache();
  await cache.put("calendar-v1:academic", JSON.stringify({ updatedAt: now.toISOString(), events: [event("recent", { start: "2026-09-20", end: "2026-09-21" })] }));
  const data = await calendarData({}, cache, { now, archive, fetcher: offline });
  assert.equal(data.events[0].id, "recent");
  assert.equal(data.sources.find(source => source.id === "academic").state, "stale");
  assert.equal((await cache.get("calendar-v1:academic")).events.length, 1);
  assert.equal(archive.events("academic").length, 0);
  durable.put = put;
  await calendarData({}, cache, { now, archive, fetcher: offline });
  assert.equal(archive.events("academic").length, 1);
});

test("frozen Notion history remains during an outage but removing the connection suppresses it", async () => {
  const archive = new CalendarArchive(persistentStorage());
  const past = event("notion:old", { source: "clubs", category: "Club events" });
  await archive.capture("clubs", [past], now);
  const cache = await freshCache();
  let data = await calendarData({ NOTION_TOKEN: "test" }, cache, { now: new Date("2026-10-02T12:00:00Z"), archive, fetcher: offline });
  assert.ok(data.events.some(item => item.id === past.id));
  data = await calendarData({}, cache, { now, archive, fetcher: offline });
  assert.ok(!data.events.some(item => item.id === past.id));
  assert.equal(archive.events("clubs").length, 1); // Stored, not exposed.
});

test("upcoming Notion events removed from the source are not retained by the archive", async () => {
  const archive = new CalendarArchive(persistentStorage());
  const cache = await freshCache();
  await cache.put("calendar-v1:clubs", JSON.stringify({ updatedAt: "2026-09-30T10:00:00Z", events: [event("notion:withdrawn", { source: "clubs", start: "2026-10-02", end: "2026-10-03" })] }));
  const data = await calendarData({ NOTION_TOKEN: "test" }, cache, { now, archive, fetcher: async url => {
    if (!url.startsWith("https://api.notion.com/")) throw new Error("Unexpected source refresh");
    return Response.json(url.endsWith("/query") ? { results: [], has_more: false } : { properties: { "Approval status": { type: "status" } } });
  } });
  assert.ok(!data.events.some(item => item.id === "notion:withdrawn"));
  assert.equal(archive.events("clubs").length, 0);
});

test("the production processor wires persistent archive storage into JSON and ICS routes", async () => {
  const durable = persistentStorage();
  const archive = new CalendarArchive(durable);
  await archive.capture("academic", [event()], now);
  const cache = memoryStorage();
  for (const source of SOURCES) await cache.put(`calendar-v1:${source.id}`, JSON.stringify({ updatedAt: new Date().toISOString(), events: [] }));
  for (const path of ["/api/calendar", "/api/calendar.ics"]) {
    const processor = new CalendarProcessor({ storage: durable }, { CALENDAR_CACHE: cache });
    const response = await processor.fetch(new Request(`https://calendar.example${path}`));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Past event/);
  }
  assert.equal(durable.writes, 1);
});
