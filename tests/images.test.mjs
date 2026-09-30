import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { buildSite, checkImages } from "../scripts/build.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ctsg-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "public");
  const output = join(root, "dist/public");
  await mkdir(join(source, "images/members/2030"), { recursive: true });
  await mkdir(join(source, "data"));
  await mkdir(join(source, "styles"));
  return { source, output };
}

const pixels = (width = 24, height = 12) => sharp({ create: { width, height, channels: 4, background: { r: 179, g: 27, b: 27, alpha: 0.5 } } });

test("future year photos become WebP, references follow them, and originals stay intact", async t => {
  const { source, output } = await fixture(t);
  const photo = "images/members/2030/new person.JPG";
  await pixels(3000, 1500).jpeg().toFile(join(source, photo));
  const original = await readFile(join(source, photo));
  await writeFile(join(source, "index.html"), `<template><img src="./${photo}" srcset="./images/members/2030/new%20person.JPG 1x, ./images/members/2030/new%20person.JPG 2x"></template><picture><source type="image/jpeg" srcset="./images/members/2030/new%20person.JPG 1x"></picture>`);
  await writeFile(join(source, "styles/photo.css"), '.photo { background: url(../images/members/2030/new%20person.JPG?v=1#photo); }');
  await writeFile(join(source, "data/people.js"), `export const peopleData = { banner: { src: "./${photo}" }, years: [{ startYear: 2030, members: [{ portrait: "./${photo}", portraitSource: "https://example.org/original.jpg" }] }] };`);
  await writeFile(join(source, "images/members/2030/sources.json"), JSON.stringify({ file: "new person.JPG", source: "https://example.org/original.jpg" }));
  const result = await buildSite({ source, output });
  assert.equal(result.converted, 1);
  assert.deepEqual((await readdir(join(output, "images/members/2030"))).sort(), ["new person.webp", "sources.json"]);
  assert.deepEqual(await readFile(join(source, photo)), original);
  const metadata = await sharp(join(output, "images/members/2030/new person.webp")).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 2048);
  assert.equal(metadata.height, 1024);
  assert.match(await readFile(join(output, "index.html"), "utf8"), /type="image\/webp"/);
  assert.match(await readFile(join(output, "styles/photo.css"), "utf8"), /new%20person\.webp\?v=1#photo/);
  const data = await readFile(join(output, "data/people.js"), "utf8");
  assert.match(data, /portrait: "\.\/images\/members\/2030\/new person\.webp"/);
  assert.match(data, /portraitSource: "https:\/\/example.org\/original.jpg"/);
  assert.deepEqual(JSON.parse(await readFile(join(output, "images/members/2030/sources.json"), "utf8")), { file: "new person.webp", source: "https://example.org/original.jpg" });
});

test("small transparent PNGs retain alpha and are not enlarged; SVG and WebP stay unchanged", async t => {
  const { source, output } = await fixture(t);
  await pixels().png().toFile(join(source, "images/transparent.png"));
  await pixels().webp().toFile(join(source, "images/existing.webp"));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>';
  await writeFile(join(source, "images/logo.svg"), svg);
  await buildSite({ source, output });
  const metadata = await sharp(join(output, "images/transparent.webp")).metadata();
  assert.equal(metadata.width, 24);
  assert.equal(metadata.hasAlpha, true);
  assert.equal(await readFile(join(output, "images/logo.svg"), "utf8"), svg);
  assert.deepEqual(await readFile(join(output, "images/existing.webp")), await readFile(join(source, "images/existing.webp")));
});

test("build applies EXIF rotation before stripping metadata", async t => {
  const { source, output } = await fixture(t);
  await pixels(30, 10).jpeg().withMetadata({ orientation: 6 }).toFile(join(source, "images/rotated.jpg"));
  await buildSite({ source, output });
  const metadata = await sharp(join(output, "images/rotated.webp")).metadata();
  assert.equal(metadata.width, 10);
  assert.equal(metadata.height, 30);
  assert.equal(metadata.exif, undefined);
});

test("name collisions fail rather than silently overwrite another photo", async t => {
  const { source, output } = await fixture(t);
  await pixels().jpeg().toFile(join(source, "images/same.jpg"));
  await pixels().webp().toFile(join(source, "images/same.webp"));
  await assert.rejects(buildSite({ source, output }), /collision/);
});

test("missing local images and external rendered photos block the build", async t => {
  const { source, output } = await fixture(t);
  await writeFile(join(source, "index.html"), '<img src="./images/missing.jpg">');
  await assert.rejects(buildSite({ source, output }), /missing local image/);
  await writeFile(join(source, "index.html"), '<template><img src="https://example.org/photo.jpg"></template>');
  await assert.rejects(buildSite({ source, output }), /local WebP/);
  await writeFile(join(source, "index.html"), '<img src="https://example.org/logo.svg">');
  await writeFile(join(source, "data/people.js"), 'export const peopleData = { years: [{ members: [{ portrait: "https://example.org/photo.webp" }] }] };');
  await assert.rejects(buildSite({ source, output }), /download external photos/);
});

test("final output validation catches leftover originals and disguised non-WebP bytes", async t => {
  const { source, output } = await fixture(t);
  await buildSite({ source, output });
  await mkdir(join(output, "images"), { recursive: true });
  await pixels().png().toFile(join(output, "images/forgotten.png"));
  await assert.rejects(checkImages(output), /Unconverted image/);
  await rm(join(output, "images/forgotten.png"));
  await writeFile(join(output, "images/disguised.webp"), await pixels().png().toBuffer());
  await assert.rejects(checkImages(output), /Not a real WebP/);
});

test("rebuilding removes generated files for deleted source photos", async t => {
  const { source, output } = await fixture(t);
  await pixels().png().toFile(join(source, "images/deleted.png"));
  await buildSite({ source, output });
  await rm(join(source, "images/deleted.png"));
  await writeFile(join(source, "index.html"), '<h1>Empty gallery</h1>');
  await buildSite({ source, output });
  await assert.rejects(readFile(join(output, "images/deleted.webp")), { code: "ENOENT" });
});

test("Blog snapshot image paths are converted and external displayed photos fail validation", async t => {
  const { source, output } = await fixture(t);
  await pixels().png().toFile(join(source, "images/blog.png"));
  await writeFile(join(source, "data/blog.js"), 'export const blogData = { posts: [{ images: [{ src: "./images/blog.png" }] }] };');
  await buildSite({ source, output });
  assert.match(await readFile(join(output, "data/blog.js"), "utf8"), /blog.webp/);
  await writeFile(join(source, "data/blog.js"), 'export const blogData = { posts: [{ images: [{ src: "https://example.org/photo.webp" }] }] };');
  await assert.rejects(buildSite({ source, output }), /download external photos/);
});
