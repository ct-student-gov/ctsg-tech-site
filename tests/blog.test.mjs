import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { articleBody, loadBlog, publicPost } from "../blog/notion.mjs";
import { syncBlog } from "../scripts/sync-blog.mjs";

const id = "12345678-abcd-1234-abcd-123456789abc";
const rich = value => [{ plain_text: value, text: { content: value } }];
const paragraph = value => ({ type: "paragraph", paragraph: { rich_text: rich(value) } });
const schema = { properties: Object.fromEntries(Object.entries({ Name: "title", Publish: "checkbox", Date: "date", Images: "files", "Image Alt Text": "rich_text", "Image Credits": "rich_text" }).map(([name, type]) => [name, { type }])) };
const page = (properties = {}, extra = {}) => ({ id, last_edited_time: "2026-09-30T12:00:00Z", properties: {
  Name: { title: rich("Existing post") }, Publish: { checkbox: true }, Date: { date: { start: "2026-05-02" } },
  Images: { files: [1, 2, 3, 4, 5].map(n => ({ external: { url: `https://photos.example/${n}.png?temporary-secret` } })) },
  "Image Alt Text": { rich_text: rich([1, 2, 3, 4, 5].map(n => `Photo description ${n}`).join("\n")) },
  Internal: { rich_text: rich("Private metadata") }, ...properties,
}, ...extra });
const list = (results, cursor = null) => Response.json({ results, has_more: !!cursor, next_cursor: cursor });

test("Publish gates article text and any number of photos; dates validate and private properties stay out", () => {
  assert.equal(publicPost(page({ Publish: { checkbox: false } })), null);
  assert.equal(publicPost(page({}, { in_trash: true })), null);
  assert.equal(publicPost(page({}, { archived: true })), null);
  assert.equal(publicPost(page()).photos.length, 5);
  assert.equal(publicPost(page({ Images: { files: [] }, "Image Alt Text": { rich_text: [] } })).photos.length, 0);
  assert.equal(publicPost(page()).photos[0].alt, "Photo description 1");
  assert.throws(() => publicPost(page({ "Image Alt Text": { rich_text: rich("Only one description") } })), /one description per image/);
  assert.throws(() => publicPost(page({ Date: { date: null } })), /Date/);
  assert.throws(() => publicPost(page({ Date: { date: { start: "2026-02-30" } } })), /Date/);
  assert.throws(() => publicPost(page({ Images: { files: [{ external: { url: "file:///secret" } }] }, "Image Alt Text": { rich_text: rich("Photo") } })), /HTTPS/);
  assert.doesNotMatch(JSON.stringify(publicPost(page())), /Private metadata/);
});

test("article text preserves formatting and safe links without importing child documents or executable links", () => {
  const body = articleBody([
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Safe text", href: "javascript:alert(1)", annotations: { bold: true } }] } },
    { type: "heading_2", heading_2: { rich_text: [{ ...rich("Visit")[0], href: "https://example.org" }] } },
    { type: "child_database", has_children: true }, { type: "divider" },
  ]);
  assert.deepEqual(body[0], { type: "paragraph", richText: [{ text: "Safe text", bold: true }] });
  assert.equal(body[1].richText[0].href, "https://example.org/");
  assert.equal(body.length, 3);
  assert.throws(() => articleBody([{ ...paragraph("Nested"), has_children: true }]), /nested/);
  assert.throws(() => articleBody([{ type: "unsupported" }]), /Unsupported/);
});

test("database and article pagination are complete and source query filters publication", async () => {
  const requests = [];
  const posts = await loadBlog({ NOTION_BLOG_TOKEN: "test-only" }, { sleep: async () => {}, fetcher: async (url, options) => {
    requests.push(url);
    assert.equal(options.headers.Authorization, "Bearer test-only");
    if (!url.includes("/query") && !url.includes("/blocks/")) return Response.json(schema);
    if (url.endsWith("/query")) {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.filter, { property: "Publish", checkbox: { equals: true } });
      return body.start_cursor ? list([page()]) : list([], "next-page");
    }
    return url.includes("start_cursor") ? list([paragraph("Second")]) : list([paragraph("First")], "next-block");
  } });
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.map(block => block.richText[0].text), ["First", "Second"]);
  assert.equal(requests.length, 5);
  await assert.rejects(loadBlog({ NOTION_BLOG_TOKEN: "test-only" }, { sleep: async () => {}, fetcher: async url => url.includes("/query")
    ? Response.json({ results: [], has_more: true, next_cursor: null }) : Response.json(schema) }), /pagination/);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ctsg-blog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "public"), statePath = join(directory, "data-sync/blog.json");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "data/blog.js"), "export const blogData = {\"posts\":[]};\n");
  const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } }).png().toBuffer();
  const calls = [];
  const state = { pages: [page()], blocks: [paragraph("Original article")], failure: null };
  const fetcher = async (url, options) => {
    calls.push(url);
    if (state.failure?.(url)) return new Response(null, { status: 500 });
    if (url.startsWith("https://photos.example/")) { assert.equal(options.headers, undefined); return new Response(bytes); }
    if (url.includes("/query")) return list(state.pages);
    if (url.includes("/blocks/")) return list(state.blocks);
    return Response.json(schema);
  };
  return { root, statePath, env: { NOTION_BLOG_TOKEN: "test-only" }, fetcher, sleep: async () => {}, state, calls };
}

test("sync saves local WebP photos, caches unchanged bodies/photos, and a body hint bypasses version reuse", async t => {
  const f = await fixture(t);
  const first = await syncBlog(f);
  assert.equal(first.postCount, 1);
  assert.equal(first.downloadedPhotos, 5);
  assert.equal(new Set(first.data.posts[0].images.map(image => image.src)).size, 1);
  for (const photo of first.data.posts[0].images) {
    assert.equal((await sharp(join(f.root, photo.src)).metadata()).format, "webp");
  }
  assert.doesNotMatch(await readFile(f.statePath, "utf8"), /temporary-secret|photos.example|test-only|Private metadata/);
  f.calls.length = 0;
  f.state.pages = [page({ Images: { files: page().properties.Images.files.map(file => ({ external: { url: file.external.url.replace("temporary-secret", "new-secret") } })) } })];
  const second = await syncBlog(f);
  assert.equal(second.changed, false);
  assert.equal(second.downloadedPhotos, 0);
  assert.equal(f.calls.length, 2);
  f.state.blocks = [paragraph("Updated article")];
  const updated = await syncBlog({ ...f, changedPageIds: [id] });
  assert.equal(updated.data.posts[0].body[0].richText[0].text, "Updated article");
  assert.equal(updated.downloadedPhotos, 0);
});

test("incomplete edits retain existing posts, new incomplete posts skip, and withdrawal removes posts", async t => {
  const f = await fixture(t);
  const first = await syncBlog(f);
  first.data.posts[0].action = "View photos";
  for (const image of first.data.posts[0].images) image.caption = "Legacy caption";
  for (const photo of first.state.posts[id.replaceAll("-", "")].photos) photo.image.caption = "Legacy caption";
  await writeFile(join(f.root, "data/blog.js"), `export const blogData = ${JSON.stringify(first.data)};\n`);
  await writeFile(f.statePath, JSON.stringify(first.state));
  f.state.pages = [page({ Date: { date: null } }), page({ Name: { title: [] } }, { id: "22345678-abcd-1234-abcd-123456789abc" })];
  const invalid = await syncBlog(f);
  assert.equal(invalid.postCount, 1);
  assert.equal(invalid.data.posts[0].action, undefined);
  assert.equal(invalid.data.posts[0].images[0].caption, undefined);
  assert.equal(invalid.state.posts[id.replaceAll("-", "")].photos[0].image.caption, undefined);
  assert.equal(invalid.data.posts[0].images[0].alt, "Photo description 1");
  assert.deepEqual(invalid.data.posts[0].body, first.data.posts[0].body);
  assert.match(invalid.warnings[0], /kept last published/);
  assert.match(invalid.warnings[1], /skipped incomplete/);
  f.state.pages = [];
  const withdrawn = await syncBlog(f);
  assert.equal(withdrawn.postCount, 0);
  assert.deepEqual(withdrawn.state.posts, {});
});

test("failed APIs and later image downloads leave the public snapshot and saved state intact", async t => {
  const f = await fixture(t);
  await syncBlog(f);
  const snapshot = await readFile(join(f.root, "data/blog.js")), state = await readFile(f.statePath);
  f.state.pages = [page({ Images: { files: [{ external: { url: "https://photos.example/new.png" } }, { external: { url: "https://photos.example/failing.png" } }] }, "Image Alt Text": { rich_text: rich("First\nSecond") } })];
  f.state.failure = url => url.includes("failing.png");
  await assert.rejects(syncBlog(f), /download failed/);
  assert.deepEqual(await readFile(join(f.root, "data/blog.js")), snapshot);
  assert.deepEqual(await readFile(f.statePath), state);
  f.state.failure = url => url.includes("/query");
  await assert.rejects(syncBlog(f), /HTTP 500/);
  assert.deepEqual(await readFile(join(f.root, "data/blog.js")), snapshot);
});

test("legacy presentation fields are removed while descriptions and credits come from Notion", async t => {
  const f = await fixture(t);
  const first = await syncBlog(f);
  const saved = JSON.parse(await readFile(f.statePath, "utf8"));
  for (const photo of saved.posts[id.replaceAll("-", "")].photos) Object.assign(photo.image, { alt: "Original description", caption: "Original caption", credit: "Photo: CTSG." });
  await writeFile(f.statePath, JSON.stringify(saved));
  first.data.posts[0].action = "View photos";
  for (const image of first.data.posts[0].images) image.caption = "Original caption";
  await writeFile(join(f.root, "data/blog.js"), `export const blogData = ${JSON.stringify(first.data)};\n`);
  f.state.pages = [page({ Images: { files: [{ external: { url: "https://photos.example/new-host-path.png" } }] }, "Image Alt Text": { rich_text: rich("Notion description") }, "Image Credits": { rich_text: rich("Photo: New credit.") } })];
  const result = await syncBlog(f);
  assert.equal(result.downloadedPhotos, 1);
  assert.equal(result.data.posts[0].action, undefined);
  assert.equal(result.data.posts[0].images[0].caption, undefined);
  assert.equal(result.data.posts[0].images[0].src, first.data.posts[0].images[0].src);
  assert.equal(result.data.posts[0].images[0].credit, "Photo: New credit.");
  assert.equal(result.data.posts[0].images[0].alt, "Notion description");
  assert.deepEqual(result.state.posts[id.replaceAll("-", "")].photos[0].image, result.data.posts[0].images[0]);
  assert.doesNotMatch(await readFile(f.statePath, "utf8"), /caption/);
  assert.doesNotMatch(await readFile(join(f.root, "data/blog.js"), "utf8"), /"action"|"caption"/);
});

test("matching images across posts reuse one file and remain cached after an unchanged sync", async t => {
  const f = await fixture(t);
  const first = await syncBlog(f);
  const shared = first.data.posts[0].images[0].src;
  const otherId = "22345678-abcd-1234-abcd-123456789abc";
  f.state.pages.push(page({ Date: { date: { start: "2025-10-30" } } }, { id: otherId }));
  const second = await syncBlog(f);
  assert.equal(second.postCount, 2);
  assert.equal(second.downloadedPhotos, 5);
  assert.deepEqual([...new Set(second.data.posts.flatMap(post => post.images.map(image => image.src)))], [shared]);
  f.calls.length = 0;
  const third = await syncBlog(f);
  assert.equal(third.downloadedPhotos, 0);
  assert.equal(third.changed, false);
  assert.equal(f.calls.length, 2);
});

test("Notion alt-text edits update every image without downloading unchanged photos", async t => {
  const f = await fixture(t);
  await syncBlog(f);
  f.state.pages = [page({ "Image Alt Text": { rich_text: rich([1, 2, 3, 4, 5].map(n => `Edited description ${n}`).join("\n")) } })];
  const result = await syncBlog(f);
  assert.equal(result.downloadedPhotos, 0);
  assert.equal(result.data.posts[0].images[0].alt, "Edited description 1");
  assert.equal(result.state.posts[id.replaceAll("-", "")].photos[0].image.alt, "Edited description 1");
});
