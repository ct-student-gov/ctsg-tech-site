import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicClub, loadClubs, JOIN_FIELD, LINKS_FIELD } from "../clubs/notion.mjs";
import { syncClubs } from "../scripts/sync-clubs.mjs";

const id = "12345678-abcd-1234-abcd-123456789abc";
const env = { NOTION_CLUBS_TOKEN: "test-only", NOTION_CLUBS_DATA_SOURCE_ID: id };
const rich = value => [{ plain_text: value }];
const schema = { properties: Object.fromEntries(Object.entries({
  Name: "title", Publish: "checkbox", Description: "rich_text", President: "rich_text",
  "Vice President": "rich_text", Treasurer: "rich_text", "Faculty/Staff Advisor": "rich_text",
  [JOIN_FIELD]: "rich_text", [LINKS_FIELD]: "rich_text",
}).map(([name, type]) => [name, { type }])) };
const page = (properties = {}, extra = {}) => ({ id, properties: {
  Name: { title: rich("Example club") }, Publish: { checkbox: true },
  Description: { rich_text: rich("Club description") },
  President: { rich_text: rich("Alex // alex@example.org") },
  "Faculty/Staff Advisor": { rich_text: rich("Advisor") },
  [JOIN_FIELD]: { rich_text: rich("Join our group") },
  [LINKS_FIELD]: { rich_text: rich("https://example.org/join") },
  Funding: { rich_text: rich("Private registration answer") }, ...properties,
}, ...extra });
const list = (results, cursor = null) => Response.json({ results, has_more: !!cursor, next_cursor: cursor });
const sleep = async () => {};

test("only published clubs and the agreed public fields are imported", () => {
  for (const extra of [{ archived: true }, { in_trash: true }]) assert.equal(publicClub(page({}, extra)), null);
  assert.equal(publicClub(page({ Publish: { checkbox: false } })), null);
  assert.equal(publicClub(page({ Publish: undefined })), null);
  assert.throws(() => publicClub(page({ Name: { title: [] } })), /Name/);
  const club = publicClub(page());
  assert.deepEqual(club.officers, [{ role: "President", name: "Alex // alex@example.org" }, { role: "Faculty/Staff Advisor", name: "Advisor" }]);
  assert.equal(club.links, "https://example.org/join");
  assert.doesNotMatch(JSON.stringify(club), /Funding|Private registration/);
});

test("resolves the supplied database, verifies the schema and imports every page in alphabetical order", async () => {
  const calls = [];
  const result = await loadClubs({ NOTION_CLUBS_TOKEN: "test-only" }, { sleep, fetcher: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, "Bearer test-only");
    assert.equal(options.redirect, "error");
    if (url.includes("/databases/")) return Response.json({ data_sources: [{ id }] });
    if (!url.endsWith("/query")) return Response.json(schema);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.filter, { property: "Publish", checkbox: { equals: true } });
    return body.start_cursor ? list([page({ Name: { title: rich("Alpha") } }, { id: "22345678-abcd-1234-abcd-123456789abc" })]) : list([page()], "next");
  } });
  assert.deepEqual(result.clubs.map(club => club.name), ["Alpha", "Example club"]);
  assert.equal(calls.length, 4);
});

test("rejects missing schema, incomplete queries, repeated cursors and duplicate rows", async () => {
  await assert.rejects(loadClubs(env, { sleep, fetcher: async () => Response.json({ properties: {} }) }), /schema/);
  for (const response of [
    { results: [], has_more: true, next_cursor: null },
    { results: [], has_more: true, next_cursor: "repeated" },
    { results: [], has_more: false, request_status: { type: "incomplete" } },
    { results: [page(), page()], has_more: false },
  ]) {
    await assert.rejects(loadClubs(env, { sleep, fetcher: async url => Response.json(url.endsWith("/query") ? response : schema) }), /Incomplete|Duplicate/);
  }
});

test("no-op sync is stable, withdrawals remove clubs, and failures preserve the saved files", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ctsg-clubs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "public"), statePath = join(directory, "data-sync/clubs.json");
  let pages = [page()], failure = false;
  const options = { root, statePath, env, sleep, fetcher: async url => {
    if (failure) return new Response(null, { status: 429 });
    return url.endsWith("/query") ? list(pages) : Response.json(schema);
  } };
  assert.equal((await syncClubs(options)).changed, true);
  assert.equal((await syncClubs(options)).changed, false);
  const snapshot = await readFile(join(root, "data/clubs.json"), "utf8");
  const state = await readFile(statePath, "utf8");
  failure = true;
  await assert.rejects(syncClubs(options), /HTTP 429/);
  assert.equal(await readFile(join(root, "data/clubs.json"), "utf8"), snapshot);
  assert.equal(await readFile(statePath, "utf8"), state);
  failure = false;
  pages = [page({ Name: { title: [] } })];
  await assert.rejects(syncClubs(options), /Name/);
  assert.equal(await readFile(join(root, "data/clubs.json"), "utf8"), snapshot);
  pages = [];
  assert.equal((await syncClubs(options)).clubCount, 0);
  assert.deepEqual(JSON.parse(await readFile(join(root, "data/clubs.json"), "utf8")), { clubs: [] });
});
