import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CalendarArchive } from "../calendar/archive.mjs";
import { notionRepositorySource } from "../calendar/repository.mjs";
import { NOTION_SOURCES, ACADEMIC_URL, TECH_ACADEMIC_URL, DEPARTMENT_SOURCES, notionEvent } from "../calendar/sources.mjs";
import { syncCalendar } from "../scripts/sync-calendar.mjs";
import { calendarHealth } from "../calendar/coverage.mjs";
import staticWorker from "../calendar/static-worker.mjs";

const now = new Date("2026-09-30T12:00:00.000Z");
const source = NOTION_SOURCES[0];
const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const rich = value => [{ plain_text: value }];
const page = ({ pageId = id, title = "Club picnic", date = "2026-10-10", approval = "Published", edited = "2026-09-29T12:00:00.000Z", ...rest } = {}) => ({
  id: pageId, last_edited_time: edited, parent: { data_source_id: source.dataSource },
  properties: {
    "Approval status": { status: { name: approval } }, "Event Title": { title: rich(title) },
    Date: { date: { start: date } }, Description: { rich_text: rich("Public event details") },
    "Private notes": { rich_text: rich("Do not expose internal notes") },
  }, ...rest,
});
const schema = { properties: { "Approval status": { type: "status" }, Date: { type: "date" } } };
const list = (results, next_cursor = null) => Response.json({ results, has_more: !!next_cursor, next_cursor });
const noSleep = async () => {};

function notionFetch(results = [], missing = new Map(), requests = []) {
  return async (url, options) => {
    requests.push({ url, body: options.body && JSON.parse(options.body) });
    assert.equal(options.headers.Authorization, "Bearer test-only");
    if (url.includes("/pages/")) {
      const result = missing.get(url.split("/").at(-1));
      return result ? Response.json(result) : new Response(null, { status: 404 });
    }
    if (url.endsWith("/query")) return list(results);
    return Response.json(schema);
  };
}

test("incremental query requests changed or recent records without polling archived pages", async () => {
  const archive = new CalendarArchive();
  const old = notionEvent(page({ date: "2024-01-01" }), source);
  await archive.capture(source.id, [old], now);
  const state = { clubs: { cursor: "2026-09-29T12:00:00.000Z", versions: { [id]: "2026-09-29T12:00:00.000Z" } } };
  const requests = [];
  const result = await notionRepositorySource(source, { NOTION_TOKEN: "test-only" }, state, archive, [], {
    now, sleep: noSleep, fetcher: notionFetch([], new Map(), requests),
  });
  assert.deepEqual(result.events, []);
  assert.deepEqual(archive.events(source.id), [old]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body.filter, { or: [
    { timestamp: "last_edited_time", last_edited_time: { on_or_after: "2026-09-29T11:55:00.000Z" } },
    { property: "Date", date: { on_or_after: "2026-09-28" } },
  ] });
  assert.ok(!requests.some(request => request.url.includes("/pages/")));
});

test("historical edits replace the saved event and withdrawn approval removes it", async () => {
  const archive = new CalendarArchive();
  await archive.capture(source.id, [notionEvent(page({ date: "2024-01-01" }), source)], now);
  const state = { clubs: { cursor: "2026-09-29T12:00:00.000Z", versions: {} } };
  const updated = page({ date: "2024-01-01", title: "Corrected historical title", edited: now.toISOString() });
  const result = await notionRepositorySource(source, { NOTION_TOKEN: "test-only" }, state, archive, [], {
    now, sleep: noSleep, fetcher: notionFetch([updated]),
  });
  assert.equal(result.events[0].title, "Corrected historical title");
  assert.equal(archive.events(source.id).length, 0);
  await archive.capture(source.id, result.events, now);
  assert.equal(archive.events(source.id)[0].title, "Corrected historical title");
  const withdrawn = await notionRepositorySource(source, { NOTION_TOKEN: "test-only" }, state, archive, [], {
    now, sleep: noSleep, fetcher: notionFetch([page({ date: "2024-01-01", approval: "Pending", edited: now.toISOString() })]),
  });
  assert.deepEqual(withdrawn.events, []);
  assert.deepEqual(archive.events(source.id), []);
  assert.equal(state.clubs.versions[id], undefined);
  assert.doesNotMatch(JSON.stringify(state), /Private|internal notes/);
});

test("explicit historical webhook hints detect deletion without routine archive polling", async () => {
  const archive = new CalendarArchive();
  await archive.capture(source.id, [notionEvent(page({ date: "2024-01-01" }), source)], now);
  const requests = [];
  await notionRepositorySource(source, { NOTION_TOKEN: "test-only" }, {}, archive, [], {
    now, sleep: noSleep, changedPageIds: [id], fetcher: notionFetch([], new Map(), requests),
  });
  assert.ok(requests.some(request => request.url.endsWith(`/pages/${id}`)));
  assert.deepEqual(archive.events(source.id), []);
});

test("deleted or moved upcoming records are removed even when absent from a database query", async () => {
  for (const missing of [new Map(), new Map([[id, page({ parent: { data_source_id: NOTION_SOURCES[1].dataSource } })]])]) {
    const requests = [];
    const result = await notionRepositorySource(source, { NOTION_TOKEN: "test-only" }, {}, new CalendarArchive(), [notionEvent(page(), source)], {
      now, sleep: noSleep, fetcher: notionFetch([], missing, requests),
    });
    assert.deepEqual(result.events, []);
    assert.equal(requests.filter(request => request.url.includes("/pages/")).length, 1);
  }
});

test("Notion repository pagination is complete and malformed pagination fails closed", async () => {
  const cursors = [];
  const result = await notionRepositorySource(source, { NOTION_TOKEN: "test-only" }, {}, new CalendarArchive(), [], {
    now, sleep: noSleep, fetcher: async (url, options) => {
      if (!url.endsWith("/query")) return Response.json(schema);
      const body = JSON.parse(options.body); cursors.push(body.start_cursor);
      return body.start_cursor ? list([page({ pageId: secondId })]) : list([page()], "next-page");
    },
  });
  assert.equal(result.events.length, 2);
  assert.deepEqual(cursors, [undefined, "next-page"]);
  for (const invalid of [
    { results: [], has_more: true },
    { results: [], has_more: true, next_cursor: "repeated" },
    { results: [], request_status: { type: "incomplete" } },
    { has_more: false },
  ]) {
    const state = {};
    await assert.rejects(notionRepositorySource(source, { NOTION_TOKEN: "test-only" }, state, new CalendarArchive(), [], {
      now, sleep: noSleep, fetcher: async url => Response.json(url.endsWith("/query") ? invalid : schema),
    }), /pagination|Incomplete/);
    assert.deepEqual(state, {});
  }
});

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const academicHTML = fixture("registrar-academic.html");
const techAcademicHTML = fixture("tech-academic.html");
function allSourcesFetch({ pages = [], failure, requests = [] } = {}) {
  return async (url, options) => {
    requests.push(url);
    if (url.startsWith("https://api.notion.com/")) {
      if (failure) return new Response(null, { status: failure });
      if (url.includes("/pages/")) return new Response(null, { status: 404 });
      if (url.endsWith("/query")) return list(url.includes(source.dataSource) ? pages : []);
      return Response.json(schema);
    }
    if (url === ACADEMIC_URL) return new Response(academicHTML);
    if (url === TECH_ACADEMIC_URL) return new Response(techAcademicHTML);
    if (DEPARTMENT_SOURCES.some(source => source.url === url)) return new Response("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n");
    if (new URL(url).pathname === "/wp-json/crn/filter/events") return Response.json({ html: "", count: 0, total: 0, totalPages: 0 });
    throw new Error(`Unexpected source ${url}`);
  };
}
async function repositoryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ctsg-calendar-repository-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = ["public/data/calendar.json", "public/data/calendar.ics", "data-sync/calendar.json"];
  const contents = () => Promise.all(paths.map(path => readFile(join(root, path), "utf8")));
  const sync = options => syncCalendar({ root, env: { NOTION_TOKEN: "test-only" }, now, sleep: noSleep, ...options });
  return { root, contents, sync };
}

test("quota errors stop Notion requests and preserve all on-disk snapshots", async t => {
  const { contents, sync } = await repositoryFixture(t);
  await sync({ fetcher: allSourcesFetch({ pages: [page()] }) });
  const before = await contents();
  const requests = [];
  await assert.rejects(sync({ fetcher: allSourcesFetch({ failure: 429, requests }) }), /Saved files were not replaced/);
  assert.equal(requests.filter(url => url.startsWith("https://api.notion.com/")).length, 1);
  assert.deepEqual(await contents(), before);
});

test("an unchanged repository reconciliation leaves JSON, ICS and metadata byte-identical", async t => {
  const { contents, sync } = await repositoryFixture(t);
  await sync({ fetcher: allSourcesFetch({ pages: [page()] }) });
  const before = await contents();
  const result = await sync({ now: new Date(+now + 5 * 60000), fetcher: allSourcesFetch({ pages: [page()] }) });
  assert.equal(result.changed, false);
  assert.deepEqual(await contents(), before);
});

test("first import seeds history without treating merged public events as a feed coverage baseline", async t => {
  const { root, sync } = await repositoryFixture(t);
  const subscription = "https://cornelltech.campusgroups.com/ics?uid=test-only&type=group&eid=career";
  const current = { id: "career-management:upcoming", source: "career-management", title: "Career workshop", start: "2026-10-07T17:00:00.000Z", end: "2026-10-07T18:00:00.000Z" };
  const historical = { ...current, id: "career-management:past", title: "Past workshop", start: "2024-01-01T17:00:00.000Z", end: "2024-01-01T18:00:00.000Z" };
  await mkdir(join(root, "public/data"), { recursive: true });
  await writeFile(join(root, "public/data/calendar.json"), JSON.stringify({
    generatedAt: now.toISOString(), events: [historical, current],
    sources: ["career-management", "career-management-students", "clubs"].map(id => ({
      id, updatedAt: now.toISOString(), coverage: { version: 1, warnings: [] },
      window: { end: "2027-11-01T00:00:00.000Z" },
    })),
  }));
  const env = { NOTION_TOKEN: "test-only", CAMPUSGROUPS_CAREER_MANAGEMENT_URL: subscription };
  let includeCurrent = true;
  const otherSources = allSourcesFetch();
  const fetcher = (url, options) => url === subscription ? new Response([
    "BEGIN:VCALENDAR", "VERSION:2.0",
    ...(includeCurrent ? ["BEGIN:VEVENT", "UID:upcoming", "SUMMARY:Career workshop", "DTSTART:20261007T170000Z", "DTEND:20261007T180000Z",
      "CATEGORIES;X-CG-CATEGORY=club_acronym:CTCAREERS", "URL:https://cornelltech.campusgroups.com/rsvp?id=123", "END:VEVENT"] : []),
    "END:VCALENDAR", "",
  ].join("\r\n")) : otherSources(url, options);
  const imported = await sync({ env, fetcher });
  assert.ok(imported.data.events.some(event => event.id === historical.id));
  assert.ok(imported.data.events.some(event => event.id === current.id));
  for (const id of ["career-management", "career-management-students"]) {
    const coverage = imported.data.sources.find(source => source.id === id).coverage;
    assert.equal(coverage.previousUpcomingCount, null);
    assert.deepEqual(coverage.warnings, []);
  }
  const saved = JSON.parse(await readFile(join(root, "data-sync/calendar.json"), "utf8"));
  for (const cached of Object.values(saved.live)) assert.equal(cached.coverage.version, 1);
  // Once real feed state exists, an actual withdrawal still gets diagnosed.
  includeCurrent = false;
  const refreshed = await sync({ env, fetcher, now: new Date(+now + 60000) });
  assert.ok(refreshed.data.events.some(event => event.id === historical.id));
  assert.ok(!refreshed.data.events.some(event => event.id === current.id));
  assert.equal(refreshed.data.sources.find(source => source.id === "career-management-students").coverage.warnings[0].code, "sudden-empty");
});

test("Notion-only refreshes preserve public feed diagnostics without refetches or needless commits", async t => {
  const { contents, sync } = await repositoryFixture(t);
  await sync({ fetcher: allSourcesFetch({ pages: [page()] }) });
  const before = await contents();
  const requests = [];
  const result = await sync({ notionOnly: true, now: new Date(+now + 5 * 60000), fetcher: allSourcesFetch({ pages: [page()], requests }) });
  assert.ok(requests.every(url => url.startsWith("https://api.notion.com/")));
  assert.equal(result.changed, false);
  assert.deepEqual(await contents(), before);
  assert.ok(calendarHealth(result.data, now).sources.every(source => !source.issues.some(issue => issue.code === "coverage-unavailable")));
});

test("a fresh process retains archived events from repository files without refetching them", async t => {
  const { root, sync } = await repositoryFixture(t);
  await sync({ fetcher: allSourcesFetch({ pages: [page({ date: "2024-01-01" })] }) });
  const moduleURL = new URL("../scripts/sync-calendar.mjs", import.meta.url).href;
  const script = `
    import { syncCalendar } from ${JSON.stringify(moduleURL)};
    const requests = [];
    const result = await syncCalendar({ root: process.argv[1], now: new Date(${JSON.stringify(now.toISOString())}),
      env: { NOTION_TOKEN: "test-only" }, notionOnly: true, sleep: async () => {}, fetcher: async url => {
        requests.push(url);
        if (!url.startsWith("https://api.notion.com/")) throw new Error("Unexpected public feed request");
        if (url.includes("/pages/")) throw new Error("Unexpected archived page request");
        return Response.json(url.endsWith("/query") ? { results: [], has_more: false } : ${JSON.stringify(schema)});
      } });
    console.log(JSON.stringify({ events: result.data.events, requests }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, root]);
  const result = JSON.parse(stdout);
  assert.ok(result.events.some(event => event.id === `notion:${id}` && event.start === "2024-01-01"));
  assert.equal(result.requests.length, 6);
  assert.ok(result.requests.every(url => !url.includes("/pages/")));
});

test("static calendar endpoint serves repo files without Notion, KV, or Durable Object access", async t => {
  const requests = [];
  const env = { CALENDAR_SNAPSHOT_BASE_URL: "https://site.example/data/" };
  for (const name of ["NOTION_TOKEN", "CALENDAR_CACHE", "CALENDAR_PROCESSOR"]) Object.defineProperty(env, name, {
    get() { throw new Error(`Unexpected access to ${name}`); },
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: url.href, options });
    assert.equal(options.redirect, "manual", "Workers support manual redirects; unexpected upstream redirects must fail closed");
    return new Response(options.method === "HEAD" ? null : "saved snapshot");
  });
  for (const [path, file] of [["/api/calendar", "calendar.json"], ["/api/calendar.ics", "calendar.ics"]]) {
    const response = await staticWorker.fetch(new Request(`https://worker.example${path}`), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "saved snapshot");
    assert.equal(requests.at(-1).url, `https://site.example/data/${file}`);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  }
  assert.equal((await staticWorker.fetch(new Request("https://worker.example/api/calendar", { method: "HEAD" }), env)).status, 200);
  for (const [path, method, status] of [["/refresh", "GET", 404], ["/api/calendar", "POST", 405]]) {
    assert.equal((await staticWorker.fetch(new Request(`https://worker.example${path}`, { method }), env)).status, status);
  }
  assert.equal(requests.length, 3);
});
