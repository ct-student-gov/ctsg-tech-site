import test from "node:test";
import assert from "node:assert/strict";
import { createPublishedPreview } from "../scripts/preview-data.mjs";

test("preview reads published snapshots and shares a five-minute cache across requests and calendar aliases", async () => {
  let time = 0, value = "original", calls = 0;
  const read = createPublishedPreview({ now: () => time, fetcher: async (url, options) => {
    calls++;
    assert.equal(url.href, "https://ct-student-gov.github.io/ctsg-tech-site/public/data/calendar.json");
    assert.equal(options.headers, undefined);
    return new Response(value);
  } });
  const initial = await read("/data/calendar.json");
  assert.equal(await initial.text(), "original");
  assert.match(initial.headers.get("content-type"), /application\/json/);
  value = "latest"; time = 299999;
  assert.equal(await (await read("/api/calendar")).text(), "original");
  assert.equal(calls, 1);
  time = 300000;
  assert.equal(await (await read("/data/calendar.json")).text(), "latest");
  assert.equal(calls, 2);
});

test("simultaneous People requests share a fetch, and an outage permits local fallback without retry storms", async () => {
  let time = 0, calls = 0;
  const read = createPublishedPreview({ now: () => time, fetcher: async () => {
    calls++;
    if (calls === 1) throw new Error("offline");
    return new Response("export const peopleData = {};");
  } });
  assert.deepEqual(await Promise.all([read("/data/people.js"), read("/data/people.js")]), [null, null]);
  assert.equal(await read("/data/people.js"), null);
  assert.equal(calls, 1);
  time = 300000;
  const responses = await Promise.all([read("/data/people.js"), read("/data/people.js")]);
  assert.equal(calls, 2);
  for (const response of responses) assert.equal(await response.text(), "export const peopleData = {};");
});

test("new hashed portraits work without a local Git update; unpublished paths and local code never fetch remotely", async () => {
  const requests = [];
  const read = createPublishedPreview({ fetcher: async url => { requests.push(url.href); return new Response(new Uint8Array([1, 2, 3])); } });
  for (const path of ["/app.js", "/styles/home.css", "/images/members/notion/2026/private.png", "/../../.env", "/images/members/notion/2026/../photo.webp", "/images/blog/notion/2026/private.svg"]) {
    assert.equal(await read(path), null);
  }
  assert.deepEqual(requests, []);
  const path = "/images/members/notion/2026/153104cd477e809d8dc4ff2d96ae3090-123456789abcdef0.webp";
  const response = await read(path);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.match(response.headers.get("cache-control"), /immutable/);
  assert.deepEqual(requests, [`https://ct-student-gov.github.io/ctsg-tech-site/public${path}`]);
});

test("failed published downloads never replace the local response with an error page", async () => {
  const read = createPublishedPreview({ fetcher: async () => new Response("Not found", { status: 404 }) });
  assert.equal(await read("/data/people.js"), null);
  assert.equal(await read("/api/calendar.ics"), null);
  assert.equal(await read("/data/blog.js"), null);
});

test("Blog preview shares the snapshot cache and serves new published WebP and SVG photos", async () => {
  const requests = [];
  const read = createPublishedPreview({ fetcher: async url => {
    requests.push(url.href);
    return new Response(url.pathname.endsWith(".js") ? "export const blogData = {posts:[]};" : "image bytes");
  } });
  const responses = await Promise.all([read("/data/blog.js"), read("/data/blog.js")]);
  for (const response of responses) {
    assert.equal(await response.text(), "export const blogData = {posts:[]};");
    assert.match(response.headers.get("content-type"), /text\/javascript/);
  }
  assert.equal(requests.length, 1);
  for (const extension of ["webp", "svg"]) {
    const path = `/images/blog/notion/2026/153104cd477e809d8dc4ff2d96ae3090-123456789abcdef0.${extension}`;
    const response = await read(path);
    assert.equal(await response.text(), "image bytes");
    assert.equal(response.headers.get("content-type"), extension === "svg" ? "image/svg+xml" : "image/webp");
    assert.equal(requests.at(-1), `https://ct-student-gov.github.io/ctsg-tech-site/public${path}`);
  }
});
