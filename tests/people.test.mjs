import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { loadPeople, publicProfile, websiteBio } from "../people/notion.mjs";
import { writePeople, readSnapshot, syncPeople } from "../scripts/sync-people.mjs";

const id = "12345678-abcd-1234-abcd-123456789abc";
const rich = value => [{ type: "text", text: { content: value }, plain_text: value }];
const block = (type, value, extra = {}) => ({ type, [type]: { rich_text: rich(value) }, ...extra });
const page = (properties = {}, extra = {}) => ({
  id, last_edited_time: "2026-09-30T12:00:00.000Z", properties: {
    Name: { title: rich("Swar Sahgal") }, Publish: { checkbox: true },
    Role: { select: { name: "DT Representative" } }, Section: { select: { name: "Representatives" } },
    "Academic Year": { multi_select: [{ name: "2026–27" }] }, "Graduation Year": { number: 2028 },
    Program: { rich_text: rich("Master of Science in Design Technology") },
    Photo: { files: [{ type: "file", file: { url: "https://images.example/portrait.webp?temporary-secret" } }] },
    Email: { rich_text: rich("private@example.org") }, Person: { people: [{ id: "private-user" }] },
    "Work Items": { relation: [{ id: "private-task" }] }, ...properties,
  }, ...extra,
});
const schema = { properties: Object.fromEntries(Object.entries({ Name: "title", Publish: "checkbox", Role: "select", Section: "select", "Academic Year": "multi_select", "Graduation Year": "number", Program: "rich_text", Photo: "files" }).map(([key, type]) => [key, { type }])) };
const list = (results, cursor = null) => Response.json({ results, has_more: !!cursor, next_cursor: cursor });

test("only published, non-archived profiles are eligible; private properties are excluded", () => {
  for (const value of [false, undefined, "true"]) assert.equal(publicProfile(page({ Publish: { checkbox: value } })), null);
  assert.equal(publicProfile(page({}, { archived: true })), null);
  assert.equal(publicProfile(page({}, { in_trash: true })), null);
  const profile = publicProfile(page());
  assert.deepEqual(profile.years, [2026]);
  assert.equal(profile.member.graduationYear, 2028);
  assert.equal(profile.member.role, "DT Representative");
  assert.doesNotMatch(JSON.stringify(profile), /private/);
});

test("historical program and graduation year may be blank; future years need no code changes", () => {
  const profile = publicProfile(page({
    Name: { title: rich("Daria") }, Program: { rich_text: [] }, "Graduation Year": { number: null },
    "Academic Year": { multi_select: [{ name: "2030–31" }, { name: "2031-2032" }] },
  }));
  assert.equal(profile.member.lastName, "");
  assert.equal(profile.member.program, null);
  assert.equal(profile.member.graduationYear, null);
  assert.deepEqual(profile.years, [2030, 2031]);
  assert.throws(() => publicProfile(page({ "Academic Year": { multi_select: [{ name: "2026–29" }] } })), /Academic Year/);
  assert.throws(() => publicProfile(page({ Section: { select: null } })), /Section/);
  assert.throws(() => publicProfile(page({ Photo: { files: [] } })), /Photo/);
});

test("only Website Bio paragraphs are published, including line breaks and rich-text runs", () => {
  assert.deepEqual(websiteBio([
    block("paragraph", "Private introduction"), block("heading_2", "Website Bio"),
    block("paragraph", "First paragraph\nsecond line"), block("paragraph", ""),
    { type: "paragraph", paragraph: { rich_text: [...rich("Fun fact: "), ...rich("hello")] } },
    block("heading_2", "Work items"), block("paragraph", "Internal notes"),
  ]), ["First paragraph\nsecond line", "Fun fact: hello"]);
  assert.deepEqual(websiteBio([block("heading_2", "Work items"), block("paragraph", "Private")]), []);
  assert.deepEqual(websiteBio([block("heading_2", "Website Bio"), { type: "child_database" }, block("paragraph", "Private")]), []);
  assert.throws(() => websiteBio([block("heading_2", "Website Bio"), block("paragraph", "Nested", { has_children: true })]), /nested/);
});

test("database and biography pagination are complete and queries filter at source", async () => {
  const requests = [], delays = [];
  const profiles = await loadPeople({ NOTION_PEOPLE_TOKEN: "test-only" }, {
    sleep: async ms => delays.push(ms),
    fetcher: async (url, options) => {
      requests.push(url);
      assert.equal(options.headers.Authorization, "Bearer test-only");
      if (!url.includes("/query") && !url.includes("/blocks/")) return Response.json(schema);
      if (url.endsWith("/query")) {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.filter, { property: "Publish", checkbox: { equals: true } });
        return body.start_cursor ? list([page()]) : list([page({ Publish: { checkbox: false } })], "page-two");
      }
      if (url.includes("start_cursor")) return list([block("paragraph", "Bio continued"), block("heading_2", "Work items"), block("paragraph", "Secret")]);
      return list([block("heading_2", "Website Bio"), block("paragraph", "Bio starts")], "bio-two");
    },
  });
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0].member.biography, ["Bio starts", "Bio continued"]);
  assert.ok(delays.every(ms => ms === 350));
  assert.equal(requests.filter(url => url.includes("/blocks/")).length, 2);
});

test("quota and server failures are not retried within the sync", async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    await assert.rejects(loadPeople({ NOTION_PEOPLE_TOKEN: "test" }, {
      sleep: async () => {},
      fetcher: async () => { calls++; return new Response(null, { status, headers: { "Retry-After": "1" } }); },
    }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
});

test("missing credentials/schema and incomplete pagination fail explicitly", async () => {
  await assert.rejects(loadPeople({}), /NOTION_PEOPLE_TOKEN/);
  await assert.rejects(loadPeople({ NOTION_PEOPLE_TOKEN: "test" }, { sleep: async () => {}, fetcher: async () => Response.json({ properties: {} }) }), /Name/);
  for (const response of [
    { results: [], has_more: true },
    { results: [], has_more: true, next_cursor: "repeated" },
    { results: [], request_status: { type: "incomplete" } },
  ]) {
    await assert.rejects(loadPeople({ NOTION_PEOPLE_TOKEN: "test" }, {
      sleep: async () => {}, fetcher: async url => Response.json(url.endsWith("/query") ? response : schema),
    }), /cursor|Incomplete/);
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ctsg-people-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data"));
  const previous = {
    banner: { src: "./images/group.webp", alt: "Existing group photo" },
    years: [{ startYear: 2026, members: [{ firstName: "Swar", lastName: "Sahgal" }, { firstName: "Withdrawn", lastName: "Person" }] }],
  };
  await writeFile(join(root, "data/people.js"), `export const peopleData = ${JSON.stringify(previous)};\n`);
  return { root, previous };
}

test("portraits become local WebP; banner, order and paragraphs survive, withdrawn records disappear", async t => {
  const { root, previous } = await fixture(t);
  const profile = publicProfile(page());
  profile.member.biography = ["Paragraph one", "Fun fact"];
  const newcomer = publicProfile(page({ Name: { title: rich("Alice New") } }, { id: "abcdefab-abcd-1234-abcd-123456789abc" }));
  newcomer.member.biography = [];
  const png = await sharp({ create: { width: 30, height: 50, channels: 3, background: "red" } }).png().toBuffer();
  const fetcher = async (url, options) => {
    assert.equal(options.headers, undefined);
    return new Response(png);
  };
  const data = await writePeople([newcomer, profile], { root, fetcher });
  assert.deepEqual(data.banner, previous.banner);
  assert.deepEqual(data.years[0].members.map(member => member.firstName), ["Swar", "Alice"]);
  const member = data.years[0].members[0];
  assert.deepEqual(member.biography, ["Paragraph one", "Fun fact"]);
  assert.match(member.portrait, /^\.\/images\/members\/notion\/2026\/[a-f0-9-]+\.webp$/);
  assert.equal((await sharp(await readFile(join(root, member.portrait))).metadata()).format, "webp");
  assert.deepEqual(await readSnapshot(root), data);
  assert.doesNotMatch(await readFile(join(root, "data/people.js"), "utf8"), /temporary-secret|private|Withdrawn|https:/);
});

test("failed downloads leave the previous snapshot intact; a successful empty import clears it", async t => {
  const { root, previous } = await fixture(t);
  await assert.rejects(writePeople([publicProfile(page())], { root, fetcher: async () => new Response("unavailable", { status: 503 }) }), /download failed/);
  assert.deepEqual(await readSnapshot(root), previous);
  await assert.rejects(writePeople([publicProfile(page())], { root, fetcher: async () => new Response("not an image") }));
  assert.deepEqual(await readSnapshot(root), previous);
  const empty = await writePeople([], { root });
  assert.deepEqual(empty, { banner: previous.banner, years: [] });
});

async function incrementalFixture(t) {
  const { root } = await fixture(t);
  const statePath = join(root, "sync-state/people.json");
  const png = await sharp({ create: { width: 30, height: 50, channels: 3, background: "red" } }).png().toBuffer();
  const requests = [];
  const source = { pages: [page()], bio: "Public biography", photo: png, failure: null };
  const fetcher = async (url, options) => {
    requests.push(url);
    if (!url.startsWith("https://api.notion.com/")) {
      assert.equal(options.headers, undefined);
      return new Response(source.photo);
    }
    if (source.failure) return new Response(null, { status: source.failure });
    if (url.endsWith("/query")) return list(source.pages);
    if (url.includes("/blocks/")) return list([block("heading_2", "Website Bio"), block("paragraph", source.bio), block("heading_2", "Work items"), block("paragraph", "Private work notes")]);
    return Response.json(schema);
  };
  const sync = options => syncPeople({ env: { NOTION_PEOPLE_TOKEN: "test-private-token" }, root, statePath, fetcher, sleep: async () => {}, ...options });
  return { root, statePath, requests, source, sync };
}

test("daily metadata checks reuse biographies and local portraits across signed URL changes", async t => {
  const { root, statePath, requests, source, sync } = await incrementalFixture(t);
  const initial = await sync();
  assert.equal(initial.profileCount, 1);
  assert.equal(initial.downloadedPhotos, 1);
  const snapshotBefore = await readFile(join(root, "data/people.js"), "utf8");
  const stateBefore = await readFile(statePath, "utf8");
  assert.doesNotMatch(stateBefore, /https:|temporary-secret|private|Email|Person|Work Items/);
  source.pages = [page({ Photo: { files: [{ file: { url: "https://images.example/portrait.webp?new-expiring-signature#fragment" } }] } })];
  requests.length = 0;
  const unchanged = await sync();
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.downloadedPhotos, 0);
  assert.equal(requests.length, 2);
  assert.equal(requests.filter(url => url.includes("/blocks/")).length, 0);
  assert.equal(await readFile(join(root, "data/people.js"), "utf8"), snapshotBefore);
  assert.equal(await readFile(statePath, "utf8"), stateBefore);
});

test("bio changes fetch only biography; webhook IDs force a refresh even with the same page timestamp", async t => {
  const { requests, source, sync } = await incrementalFixture(t);
  await sync();
  requests.length = 0;
  source.bio = "Updated public biography";
  source.pages = [page({}, { last_edited_time: "2026-09-30T13:00:00.000Z" })];
  const changed = await sync();
  assert.equal(changed.downloadedPhotos, 0);
  assert.equal(requests.length, 3);
  assert.deepEqual(changed.data.years[0].members[0].biography, [source.bio]);
  source.bio = "Another change within the same timestamp";
  const forced = await sync({ changedPageIds: [id] });
  assert.equal(forced.downloadedPhotos, 0);
  assert.deepEqual(forced.data.years[0].members[0].biography, [source.bio]);
});

test("replaced or missing portraits are downloaded, and withdrawn profiles leave both snapshots", async t => {
  const { root, statePath, requests, source, sync } = await incrementalFixture(t);
  const initial = await sync();
  const portrait = initial.data.years[0].members[0].portrait;
  await rm(join(root, portrait));
  assert.equal((await sync()).downloadedPhotos, 1);
  source.pages = [page({ Photo: { files: [{ file: { url: "https://images.example/replacement.png?signed" } }] } }, { last_edited_time: "2026-09-30T14:00:00.000Z" })];
  source.photo = await sharp({ create: { width: 30, height: 50, channels: 3, background: "blue" } }).png().toBuffer();
  requests.length = 0;
  const replacement = await sync();
  assert.equal(replacement.downloadedPhotos, 1);
  assert.notEqual(replacement.data.years[0].members[0].portrait, portrait);
  source.pages = [];
  const withdrawn = await sync();
  assert.deepEqual(withdrawn.data.years, []);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).profiles, {});
});

test("failed daily reconciliation preserves committed data and metadata for the next run", async t => {
  const { root, statePath, source, sync } = await incrementalFixture(t);
  await sync();
  const previous = await readFile(join(root, "data/people.js"), "utf8");
  const metadata = await readFile(statePath, "utf8");
  source.failure = 429;
  await assert.rejects(sync(), /HTTP 429/);
  assert.equal(await readFile(join(root, "data/people.js"), "utf8"), previous);
  assert.equal(await readFile(statePath, "utf8"), metadata);
  source.failure = null;
  source.pages = [page({ Photo: { files: [{ file: { url: "https://images.example/invalid-image" } }] } })];
  source.photo = "not an image";
  await assert.rejects(sync());
  assert.equal(await readFile(join(root, "data/people.js"), "utf8"), previous);
  assert.equal(await readFile(statePath, "utf8"), metadata);
});

test("an incomplete newcomer is skipped with field warnings while valid profile edits publish", async t => {
  const { source, sync } = await incrementalFixture(t);
  await sync();
  const testId = "abcdefab-abcd-1234-abcd-123456789abc";
  const draft = page({ Name: { title: rich("test") }, Role: { select: null }, Photo: { files: [] } }, { id: testId });
  source.bio = "Edited biography";
  source.pages = [draft, page({}, { last_edited_time: "2026-09-30T14:00:00Z" })];
  const result = await sync();
  assert.equal(result.profileCount, 1);
  assert.deepEqual(result.data.years[0].members[0].biography, [source.bio]);
  assert.match(result.warnings[0], /test: needs Role, exactly one Photo; skipped/);
  assert.equal(result.state.profiles[testId.replaceAll("-", "")], undefined);
  source.pages[0] = page({ Name: { title: rich("test") } }, { id: testId });
  const corrected = await sync();
  assert.equal(corrected.profileCount, 2);
  assert.deepEqual(corrected.warnings, []);
});

test("temporarily incomplete existing profiles retain their full published version and recover or withdraw", async t => {
  const { source, sync } = await incrementalFixture(t);
  const original = await sync();
  source.pages = [page({ Role: { select: null }, Photo: { files: [] }, "Academic Year": { multi_select: [{ name: "2027–28" }] } }, { last_edited_time: "2026-09-30T14:00:00Z" })];
  const invalid = await sync();
  assert.deepEqual(invalid.data, original.data);
  assert.deepEqual(invalid.state, original.state);
  assert.equal(invalid.changed, false);
  assert.match(invalid.warnings[0], /kept last published profile/);
  source.bio = "Corrected bio";
  source.pages = [page({}, { last_edited_time: "2026-09-30T14:00:00Z" })];
  assert.deepEqual((await sync()).data.years[0].members[0].biography, [source.bio]);
  source.pages = [page({ Publish: { checkbox: false }, Role: { select: null }, Photo: { files: [] } })];
  const withdrawn = await sync();
  assert.equal(withdrawn.profileCount, 0);
  assert.deepEqual(withdrawn.data.years, []);
  assert.deepEqual(withdrawn.state.profiles, {});
});

test("invalid bio structure is isolated but Notion API failures still abort safely", async () => {
  const invalidProfiles = [];
  const fetcher = async url => url.endsWith("/query") ? list([page()]) : url.includes("/blocks/")
    ? list([block("heading_2", "Website Bio"), block("bulleted_list_item", "Not a paragraph")]) : Response.json(schema);
  assert.deepEqual(await loadPeople({ NOTION_PEOPLE_TOKEN: "test" }, { fetcher, sleep: async () => {}, invalidProfiles }), []);
  assert.match(invalidProfiles[0].message, /plain paragraphs/);
  for (const status of [429, 503]) await assert.rejects(loadPeople({ NOTION_PEOPLE_TOKEN: "test" }, {
    sleep: async () => {}, fetcher: async url => url.includes("/blocks/") ? new Response(null, { status }) : fetcher(url),
  }), new RegExp(`HTTP ${status}`));
});
