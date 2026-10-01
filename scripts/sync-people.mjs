import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadPeople, PEOPLE_DATA_SOURCE_ID } from "../people/notion.mjs";
import { createImageCache, imageDigest, readCachedImage } from "./image-cache.mjs";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
const dataPrefix = "export const peopleData = ";

export async function readSnapshot(root) {
  const source = await readFile(join(root, "data/people.js"), "utf8");
  const start = source.indexOf(dataPrefix);
  if (start < 0) throw new Error("People snapshot has an unexpected format");
  return JSON.parse(source.slice(start + dataPrefix.length).trim().replace(/;$/, ""));
}

function photoIdentity(photoUrl) {
  const url = new URL(photoUrl);
  url.search = "";
  url.hash = "";
  // Keep only a digest: even the stable part of an attachment URL need not be
  // committed to the repository. Signed query parameters expire independently.
  return createHash("sha256").update(url.href).digest("hex");
}

async function cachedPortrait(root, cached, identity) {
  if (cached?.photoIdentity !== identity || typeof cached.portrait !== "string") return null;
  return (await readCachedImage(root, cached.portrait))?.path || null;
}

async function preparePeople(profiles, { root, fetcher, cachedProfiles = {}, invalidProfiles = [] }) {
  const previous = await readSnapshot(root);
  const years = new Map();
  // Keep the existing order of equal-rank members; the page continues to sort
  // by role and graduation year. New members have a deterministic name order.
  const oldOrder = new Map(previous.years.flatMap(year => year.members.map((member, index) =>
    [`${year.startYear}:${`${member.firstName} ${member.lastName}`.trim()}`, index])));
  const photos = [];
  const imageCache = createImageCache(root);
  let downloadedPhotos = 0;
  const nextProfiles = {};
  const warnings = [];
  for (const invalid of invalidProfiles) {
    const cached = cachedProfiles[invalid.id];
    let retained = false;
    if (cached?.portrait) for (const year of previous.years) {
      const members = year.members.filter(member => member.portrait === cached.portrait);
      if (!members.length) continue;
      if (!years.has(year.startYear)) years.set(year.startYear, []);
      years.get(year.startYear).push(...members);
      nextProfiles[invalid.id] = cached;
      retained = true;
    }
    warnings.push(`${invalid.message}; ${retained ? "kept last published profile" : "skipped incomplete profile"}.`);
  }
  for (const profile of profiles) {
    const identity = photoIdentity(profile.photoUrl);
    let portrait = await cachedPortrait(root, cachedProfiles[profile.id], identity);
    if (!portrait) {
      const response = await fetcher(profile.photoUrl, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`${profile.member.firstName}: portrait download failed (HTTP ${response.status})`);
      downloadedPhotos++;
      // Do not send Notion credentials to the image host or save its expiring URL.
      const source = Buffer.from(await response.arrayBuffer());
      const metadata = await sharp(source).metadata();
      if (!["webp", "jpeg", "png", "avif", "heif", "tiff", "gif"].includes(metadata.format)) throw new Error("Photo must be a raster image");
      const bytes = metadata.format === "webp" && metadata.width <= 2048 && metadata.height <= 2048
        ? source
        : await sharp(source).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      // Content-addressed names leave the old snapshot's images valid if a later
      // download fails, and prevent stale browser caches after a portrait edit.
      portrait = await imageCache.find(bytes);
      if (!portrait) {
        const path = `images/members/notion/${Math.min(...profile.years)}/${profile.id}-${imageDigest(bytes).slice(0, 16)}.webp`;
        photos.push({ path, bytes });
        portrait = `./${path}`;
        imageCache.remember(portrait, bytes);
      }
    }
    nextProfiles[profile.id] = {
      lastEditedTime: profile.lastEditedTime || null,
      photoIdentity: identity,
      portrait,
      biography: profile.member.biography || [],
    };
    for (const startYear of profile.years) {
      if (!years.has(startYear)) years.set(startYear, []);
      years.get(startYear).push({ ...profile.member, portrait });
    }
  }
  const name = member => `${member.firstName} ${member.lastName}`.trim();
  const data = {
    banner: previous.banner,
    years: [...years].sort(([a], [b]) => b - a).map(([startYear, members]) => ({
      startYear,
      members: members.sort((a, b) => (oldOrder.get(`${startYear}:${name(a)}`) ?? Infinity) - (oldOrder.get(`${startYear}:${name(b)}`) ?? Infinity) || name(a).localeCompare(name(b))),
    })),
  };
  return { data, photos, downloadedPhotos, warnings, profiles: Object.fromEntries(Object.entries(nextProfiles).sort(([a], [b]) => a.localeCompare(b))) };
}

function snapshotSource(data) {
  return `// Generated by npm run people:sync from Notion Team Directory.\n// Edit profiles in Notion; the group banner is maintained here.\n${dataPrefix}${JSON.stringify(data, null, 2)};\n`;
}

async function publishPrepared({ data, photos }, root, statePath, state) {
  // Fetch and validate every profile first. The workflow commits only after
  // this entire sync, the site build and image validation all succeed.
  for (const { path, bytes } of photos) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  const files = [[join(root, "data/people.js"), snapshotSource(data)]];
  if (statePath) files.push([statePath, `${JSON.stringify(state, null, 2)}\n`]);
  const changed = [];
  for (const [destination, source] of files) {
    let previous;
    try { previous = await readFile(destination, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous === source) continue;
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(`${destination}.tmp`, source);
    changed.push(destination);
  }
  for (const destination of changed) await rename(`${destination}.tmp`, destination);
  return changed.length > 0 || photos.length > 0;
}

export async function writePeople(profiles, { root = publicRoot, fetcher = fetch } = {}) {
  const prepared = await preparePeople(profiles, { root, fetcher });
  await publishPrepared(prepared, root);
  return prepared.data;
}

export async function syncPeople({
  env = process.env,
  root = publicRoot,
  statePath = join(dirname(root), "data-sync/people.json"),
  fetcher = fetch,
  sleep,
  changedPageIds = [],
} = {}) {
  const dataSource = (env.NOTION_PEOPLE_DATA_SOURCE_ID || PEOPLE_DATA_SOURCE_ID).replaceAll("-", "").toLowerCase();
  let previousState = null;
  try { previousState = JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previousState && (previousState.version !== 1 || typeof previousState.profiles !== "object" || !previousState.profiles || Array.isArray(previousState.profiles))) {
    throw new Error("People sync state has an unexpected format");
  }
  const cachedProfiles = previousState?.dataSource === dataSource ? previousState.profiles : {};
  const invalidProfiles = [];
  const profiles = await loadPeople(env, { fetcher, sleep, cachedProfiles, changedPageIds, invalidProfiles });
  const prepared = await preparePeople(profiles, { root, fetcher, cachedProfiles, invalidProfiles });
  const state = { version: 1, dataSource, profiles: prepared.profiles };
  const changed = await publishPrepared(prepared, root, statePath, state);
  return { data: prepared.data, state, profileCount: Object.keys(prepared.profiles).length, downloadedPhotos: prepared.downloadedPhotos, changed, warnings: prepared.warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await syncPeople();
    for (const warning of result.warnings) console.warn(warning);
    console.log(`Synced ${result.profileCount} published profiles across ${result.data.years.length} academic years; ${result.downloadedPhotos} portrait downloads${result.changed ? "." : "; no changes."}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
