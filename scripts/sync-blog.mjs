import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { BLOG_DATA_SOURCE_ID, loadBlog } from "../blog/notion.mjs";
import { createImageCache, imageDigest, readCachedImage } from "./image-cache.mjs";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
const prefix = "export const blogData = ";
const publicImage = ({ src, alt, width, height, credit = "" }) => ({ src, alt, width, height, credit });

export async function readBlogSnapshot(root = publicRoot) {
  const source = await readFile(join(root, "data/blog.js"), "utf8");
  const start = source.indexOf(prefix);
  if (start < 0) throw new Error("Blog snapshot has an unexpected format");
  const data = JSON.parse(source.slice(start + prefix.length).trim().replace(/;$/, ""));
  if (!Array.isArray(data.posts)) throw new Error("Blog snapshot has an unexpected format");
  return data;
}

async function cachedPhoto(root, cached) {
  return await readCachedImage(root, cached?.image?.src, { allowSvg: true }) ? cached.image : null;
}

export async function syncBlog({
  env = process.env, root = publicRoot, statePath = join(dirname(root), "data-sync/blog.json"),
  fetcher = fetch, sleep, changedPageIds = [],
} = {}) {
  const previous = await readBlogSnapshot(root);
  const dataSource = (env.NOTION_BLOG_DATA_SOURCE_ID || BLOG_DATA_SOURCE_ID).replaceAll("-", "").toLowerCase();
  let oldState = null;
  try { oldState = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (oldState && (oldState.version !== 1 || !oldState.posts || typeof oldState.posts !== "object" || Array.isArray(oldState.posts))) throw new Error("Blog sync state has an unexpected format");
  const cachedPosts = oldState?.dataSource === dataSource ? oldState.posts : {};
  const invalidPosts = [];
  const imported = await loadBlog(env, { fetcher, sleep, cachedPosts, changedPageIds, invalidPosts });
  const posts = [], nextPosts = {}, downloads = [], warnings = [];
  const imageCache = createImageCache(root);
  let downloadedPhotos = 0;
  for (const invalid of invalidPosts) {
    const old = cachedPosts[invalid.id] && previous.posts.find(post => post.id === invalid.id);
    if (old) {
      posts.push(old);
      const cached = cachedPosts[invalid.id];
      nextPosts[invalid.id] = { ...cached, photos: (cached.photos || []).map(photo => ({ ...photo, image: publicImage(photo.image) })) };
    }
    warnings.push(`${invalid.message}; ${old ? "kept last published post" : "skipped incomplete post"}.`);
  }
  for (const post of imported) {
    const images = [], photos = [];
    for (const photo of post.photos) {
      const url = new URL(photo.url); url.search = ""; url.hash = "";
      const identity = imageDigest(url.href);
      const cached = cachedPosts[post.id]?.photos?.find(photo => photo.identity === identity);
      let image = await cachedPhoto(root, cached);
      if (!image) {
        // Attachment hosts receive no Notion API credentials.
        const response = await fetcher(photo.url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`Blog image download failed (HTTP ${response.status})`);
        const source = Buffer.from(await response.arrayBuffer());
        downloadedPhotos++;
        const metadata = await sharp(source).metadata();
        if (!["svg", "webp", "jpeg", "png", "avif", "heif", "tiff", "gif"].includes(metadata.format)) throw new Error("Blog Images must contain supported images");
        const extension = metadata.format === "svg" ? "svg" : "webp";
        const bytes = extension === "svg" || (metadata.format === "webp" && metadata.width <= 2048 && metadata.height <= 2048)
          ? source : await sharp(source).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
        const dimensions = await sharp(bytes).metadata();
        let path = await imageCache.find(bytes);
        if (!path) {
          path = `./images/blog/notion/${post.date.slice(0, 4)}/${post.id}-${imageDigest(bytes).slice(0, 16)}.${extension}`;
          downloads.push({ path, bytes });
          imageCache.remember(path, bytes);
        }
        image = { src: path, width: dimensions.width, height: dimensions.height };
      }
      image = publicImage({ ...image, alt: photo.alt, credit: photo.credit });
      images.push(image);
      photos.push({ identity, image });
    }
    posts.push({ id: post.id, title: post.title, date: post.date, images, body: post.body });
    nextPosts[post.id] = { lastEditedTime: post.lastEditedTime, body: post.body, photos };
  }
  posts.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const data = { posts: posts.map(({ id, title, date, images, body }) => ({ id, title, date, images: images.map(publicImage), body })) };
  const state = { version: 1, dataSource, posts: Object.fromEntries(Object.entries(nextPosts).sort(([a], [b]) => a.localeCompare(b))) };
  // Prepare everything before replacing the saved data. A failed download or
  // API request leaves the previous snapshot and state intact.
  for (const { path, bytes } of downloads) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  const changed = [];
  for (const [path, source] of [
    [join(root, "data/blog.js"), `// Generated by npm run blog:sync from Notion Blog.\n${prefix}${JSON.stringify(data, null, 2)};\n`],
    [statePath, `${JSON.stringify(state, null, 2)}\n`],
  ]) {
    let old;
    try { old = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (old === source) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, source);
    changed.push(path);
  }
  for (const path of changed) await rename(`${path}.tmp`, path);
  return { data, state, postCount: posts.length, downloadedPhotos, changed: changed.length > 0 || downloads.length > 0, warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await syncBlog();
    for (const warning of result.warnings) console.warn(warning);
    console.log(`Synced ${result.postCount} published posts; ${result.downloadedPhotos} image downloads${result.changed ? "." : "; no changes."}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
