import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { loadPeople, publicProfile, websiteBio } from "../people/notion.mjs";
import { writePeople, readSnapshot, syncPeople } from "../scripts/sync-people.mjs";
import { imageDigest } from "../scripts/image-cache.mjs";
import { createFaviconCache } from "../scripts/people-favicons.mjs";

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
    Email: { rich_text: rich("swar@cornell.edu") }, Person: { people: [{ id: "private-user" }] },
    "Work Items": { relation: [{ id: "private-task" }] }, ...properties,
  }, ...extra,
});
const schema = { properties: Object.fromEntries(Object.entries({ Name: "title", Publish: "checkbox", Role: "select", Section: "select", "Academic Year": "multi_select", "Graduation Year": "number", Program: "rich_text", Photo: "files" }).map(([key, type]) => [key, { type }])) };
const list = (results, cursor = null) => Response.json({ results, has_more: !!cursor, next_cursor: cursor });
const multi = (...names) => ({ multi_select: names.map(name => ({ name })) });

test("roles pair with sections in selection order, including reversed order", () => {
  const roles = multi("M.Eng. ORIE Representative", "Chief of Staff");
  assert.deepEqual(publicProfile(page({ Role: roles, Section: multi("Representatives", "Executive Board") })).assignments, [
    { role: "M.Eng. ORIE Representative", section: "representatives" },
    { role: "Chief of Staff", section: "executive-board" },
  ]);
  assert.deepEqual(publicProfile(page({ Role: roles, Section: multi("Executive Board", "Representatives") })).assignments, [
    { role: "M.Eng. ORIE Representative", section: "executive-board" },
    { role: "Chief of Staff", section: "representatives" },
  ]);
  for (const properties of [
    { Role: roles, Section: multi("Representatives") },
    { Role: multi("Chief of Staff"), Section: multi("Executive Board", "Representatives") },
  ]) assert.throws(() => publicProfile(page(properties)), /same number.*paired in order/);
  assert.throws(() => publicProfile(page({ Role: multi() })), /needs Role/);
  assert.throws(() => publicProfile(page({ Section: multi("Unknown") })), /needs Section/);
});

test("only published, non-archived profiles are eligible; private properties are excluded", () => {
  for (const value of [false, undefined, "true"]) assert.equal(publicProfile(page({ Publish: { checkbox: value } })), null);
  assert.equal(publicProfile(page({}, { archived: true })), null);
  assert.equal(publicProfile(page({}, { in_trash: true })), null);
  const profile = publicProfile(page());
  assert.deepEqual(profile.years, [2026]);
  assert.equal(profile.member.graduationYear, 2028);
  assert.equal(profile.member.role, "DT Representative");
  assert.equal(profile.member.email, "swar@cornell.edu");
  assert.doesNotMatch(JSON.stringify(profile), /private/);
});

test("contact fields accept Text or Email addresses and four distinct ordered HTTP(S) links", () => {
  const profile = publicProfile(page({
    Email: { email: "swar+website@cornell.edu" },
    Links: { rich_text: rich(" https://linkedin.com/in/person \n\nhttps://github.com/person\r\nhttps://github.com/person\nhttps://example.org\nhttp://example.net\nhttps://fifth.example") },
  }));
  assert.equal(profile.member.email, "swar+website@cornell.edu");
  assert.deepEqual(profile.member.links, ["https://linkedin.com/in/person", "https://github.com/person", "https://example.org/", "http://example.net/"]);
  const empty = publicProfile(page({ Email: { rich_text: [] }, Links: { rich_text: [] } }));
  assert.equal(empty.member.email, undefined);
  assert.equal(empty.member.links, undefined);
  for (const value of ["javascript:alert(1)", "https://user:password@example.org", "example.org", "mailto:person@example.org"]) {
    assert.throws(() => publicProfile(page({ Links: { rich_text: rich(value) } })), /Links/);
  }
  for (const value of ["not an address", "person@example.org?subject=test", "person@example.org\nBcc:test@example.org"]) {
    assert.throws(() => publicProfile(page({ Email: { rich_text: rich(value) } })), /Email/);
  }
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
  assert.equal(data.years[0].members[1].portrait, member.portrait);
  assert.equal((await readdir(join(root, "images/members/notion/2026"))).length, 1);
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
  const source = { pages: [page()], schema, bio: "Public biography", photo: png, failure: null };
  const fetcher = async (url, options) => {
    requests.push(url);
    if (!url.startsWith("https://api.notion.com/")) {
      assert.equal(options.headers, undefined);
      return new Response(source.photo);
    }
    if (source.failure) return new Response(null, { status: source.failure });
    if (url.endsWith("/query")) return list(source.pages);
    if (url.includes("/blocks/")) return list([block("heading_2", "Website Bio"), block("paragraph", source.bio), block("heading_2", "Work items"), block("paragraph", "Private work notes")]);
    return Response.json(source.schema);
  };
  const sync = options => syncPeople({ env: { NOTION_PEOPLE_TOKEN: "test-private-token" }, root, statePath, fetcher, sleep: async () => {}, ...options });
  return { root, statePath, requests, source, sync };
}

test("multi-select sync emits exactly one card per ordered pair per year and retains it on mismatch", async t => {
  const { source, requests, sync } = await incrementalFixture(t);
  source.schema = structuredClone(schema);
  source.schema.properties.Role.type = "multi_select";
  source.schema.properties.Section.type = "multi_select";
  const properties = {
    Role: multi("M.Eng. ORIE Representative", "Chief of Staff"),
    Section: multi("Representatives", "Executive Board"),
    "Academic Year": multi("2026–27", "2027–28"),
  };
  source.pages = [page(properties)];
  const initial = await sync();
  assert.equal(initial.profileCount, 1);
  for (const year of initial.data.years) {
    assert.deepEqual(year.members.map(({ role, section }) => ({ role, section })), [
      { role: "M.Eng. ORIE Representative", section: "representatives" },
      { role: "Chief of Staff", section: "executive-board" },
    ]);
    assert.ok(year.members.every(member => member.profileId === id.replaceAll("-", "")));
  }
  assert.equal(initial.downloadedPhotos, 1);
  assert.equal(requests.filter(url => url.includes("/blocks/")).length, 1);
  assert.equal((await sync()).changed, false);
  source.pages = [page({ ...properties, Section: multi("Representatives") })];
  const invalid = await sync();
  assert.deepEqual(invalid.data, initial.data);
  assert.match(invalid.warnings[0], /same number.*kept last published/);
  source.pages = [page({ ...properties, Section: multi("Executive Board", "Representatives") })];
  const reordered = await sync();
  assert.deepEqual(reordered.data.years[0].members.map(member => member.section), ["executive-board", "representatives"]);
});

test("fallback identifies records by ID even when their portraits are shared", async t => {
  const { source, sync } = await incrementalFixture(t);
  const secondId = "abcdefab-abcd-1234-abcd-123456789abc";
  source.pages = [page(), page({ Role: { select: { name: "Chief of Staff" } }, Section: { select: { name: "Executive Board" } } }, { id: secondId })];
  const initial = await sync();
  assert.equal(initial.data.years[0].members[0].portrait, initial.data.years[0].members[1].portrait);
  source.pages = [page({ Role: multi() }), page({ Role: multi() }, { id: secondId })];
  assert.deepEqual((await sync()).data, initial.data);
  // A removed record must not reappear through another record's shared photo.
  source.pages = [source.pages[0]];
  const remaining = await sync();
  assert.equal(remaining.data.years[0].members.length, 1);
  assert.equal(remaining.data.years[0].members[0].role, "DT Representative");
});

test("legacy fallback preserves unique portraits but never copies ambiguous shared-photo cards", async t => {
  const { source, root, sync } = await incrementalFixture(t);
  const initial = await sync();
  const legacy = structuredClone(initial.data);
  delete legacy.years[0].members[0].profileId;
  await writeFile(join(root, "data/people.js"), `export const peopleData = ${JSON.stringify(legacy)};\n`);
  source.pages = [page({ Role: multi() })];
  assert.deepEqual((await sync()).data, legacy);
  source.pages = [page(), page({}, { id: "abcdefab-abcd-1234-abcd-123456789abc" })];
  const shared = (await sync()).data;
  for (const member of shared.years[0].members) delete member.profileId;
  await writeFile(join(root, "data/people.js"), `export const peopleData = ${JSON.stringify(shared)};\n`);
  source.pages = source.pages.map(value => ({ ...value, properties: { ...value.properties, Role: multi() } }));
  await assert.rejects(sync(), /cannot safely identify the legacy profile/);
  assert.deepEqual(await readSnapshot(root), shared);
});

test("contact edits publish with cached bios; one local favicon serves all same-site profiles and later runs", async t => {
  const { root, requests, source, sync } = await incrementalFixture(t);
  source.pages = [page({ Links: { rich_text: rich("https://www.linkedin.com/in/swar\nhttps://linkedin.com/in/other") } })];
  const first = await sync();
  const links = first.data.years[0].members[0].links;
  assert.equal(links.length, 2);
  assert.equal(links[0].icon, links[1].icon);
  assert.match(links[0].icon, /^\.\/images\/members\/favicons\/[a-f0-9-]+\.webp$/);
  assert.equal((await sharp(await readFile(join(root, links[0].icon))).metadata()).format, "webp");
  assert.equal(requests.filter(url => url.startsWith("https://www.google.com/")).length, 1);
  requests.length = 0;
  assert.equal((await sync()).changed, false);
  assert.equal(requests.length, 2);
  source.pages = [page({ Email: { rich_text: [] }, Links: { rich_text: rich("https://linkedin.com/in/edited") } })];
  requests.length = 0;
  const edited = await sync();
  assert.equal(edited.data.years[0].members[0].email, undefined);
  assert.equal(edited.data.years[0].members[0].links[0].href, "https://linkedin.com/in/edited");
  assert.equal(requests.length, 2);
  await writeFile(join(root, links[0].icon), "corrupt icon");
  requests.length = 0;
  await sync();
  assert.equal(requests.filter(url => url.startsWith("https://www.google.com/")).length, 1);
  source.pages = [page({ Links: { rich_text: [] } })];
  assert.equal((await sync()).data.years[0].members[0].links, undefined);
});

test("failed favicon lookups use a cached fallback, retry later, and do not stop profile sync", async t => {
  const { root } = await fixture(t);
  let calls = 0;
  const fetcher = async () => { calls++; return new Response("unavailable", { status: 503 }); };
  const first = createFaviconCache({ root, fetcher, now: 1000 });
  const links = await first.links(["https://example.org/one", "https://www.example.org/two"]);
  assert.ok(links.every(link => link.icon === null));
  assert.equal(calls, 1);
  const second = createFaviconCache({ root, fetcher, cached: first.state, now: 2000 });
  await second.links(["https://example.org/three"]);
  assert.equal(calls, 1);
  const third = createFaviconCache({ root, fetcher, cached: second.state, now: 8 * 86400000 });
  await third.links(["https://example.org/four"]);
  assert.equal(calls, 2);
  const profile = publicProfile(page({ Links: { rich_text: rich("https://example.org") } }));
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).png().toBuffer();
  const data = await writePeople([profile], { root, fetcher: async url => url.includes("google.com") ? fetcher() : new Response(png) });
  assert.equal(data.years[0].members[0].links[0].icon, null);
});

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

test("shared portraits stay cached across profile IDs and after the original profile withdraws", async t => {
  const { root, statePath, requests, source, sync } = await incrementalFixture(t);
  const secondId = "abcdefab-abcd-1234-abcd-123456789abc";
  const second = page({ Name: { title: rich("Alice New") }, Photo: { files: [{ file: { url: "https://images.example/alice.png" } }] } }, { id: secondId });
  source.pages.push(second);
  const initial = await sync();
  assert.equal(initial.downloadedPhotos, 2);
  const portrait = initial.data.years[0].members[0].portrait;
  assert.ok(initial.data.years[0].members.every(member => member.portrait === portrait));
  assert.equal((await readdir(join(root, "images/members/notion/2026"))).length, 1);
  const snapshot = await readFile(join(root, "data/people.js"), "utf8");
  const metadata = await readFile(statePath, "utf8");
  requests.length = 0;
  const unchanged = await sync();
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.downloadedPhotos, 0);
  assert.equal(requests.filter(url => url.startsWith("https://images.example/")).length, 0);
  assert.equal(await readFile(join(root, "data/people.js"), "utf8"), snapshot);
  assert.equal(await readFile(statePath, "utf8"), metadata);
  source.pages = [second];
  const remaining = await sync();
  assert.equal(remaining.downloadedPhotos, 0);
  assert.equal(remaining.data.years[0].members[0].portrait, portrait);
  assert.equal(remaining.state.profiles[id.replaceAll("-", "")], undefined);
});

test("shared portrait caches verify the filename's content hash before reusing the file", async t => {
  const { root, source, sync } = await incrementalFixture(t);
  source.pages.push(page({ Name: { title: rich("Alice New") } }, { id: "abcdefab-abcd-1234-abcd-123456789abc" }));
  const initial = await sync();
  const portrait = initial.data.years[0].members[0].portrait;
  await writeFile(join(root, portrait), "corrupt cached image");
  const repaired = await sync();
  assert.equal(repaired.downloadedPhotos, 2);
  assert.ok(repaired.data.years[0].members.every(member => member.portrait === portrait));
  assert.equal((await sharp(await readFile(join(root, portrait))).metadata()).format, "webp");
  assert.equal((await readdir(join(root, "images/members/notion/2026"))).length, 1);
});

test("portraits reuse identical published Blog images without creating another file", async t => {
  const { root, source, sync } = await incrementalFixture(t);
  const bytes = await sharp(source.photo).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const path = `./images/blog/notion/2026/abcdefababcd1234abcd123456789abc-${imageDigest(bytes).slice(0, 16)}.webp`;
  await mkdir(join(root, "images/blog/notion/2026"), { recursive: true });
  await writeFile(join(root, path), bytes);
  const initial = await sync();
  assert.equal(initial.downloadedPhotos, 1);
  assert.equal(initial.data.years[0].members[0].portrait, path);
  await assert.rejects(readdir(join(root, "images/members")), { code: "ENOENT" });
  const unchanged = await sync();
  assert.equal(unchanged.downloadedPhotos, 0);
  assert.equal(unchanged.changed, false);
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
