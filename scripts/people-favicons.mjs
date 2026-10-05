import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { imageDigest } from "./image-cache.mjs";

const retryDelay = 7 * 24 * 60 * 60 * 1000;
const cachedPath = /^\.\/images\/members\/favicons\/[a-f0-9]{16}-([a-f0-9]{16})\.webp$/;

// Fetch once per hostname during sync, never in visitors' browsers. Both saved
// icons and failed lookups are shared by all profiles and subsequent runs.
export function createFaviconCache({ root, fetcher, cached = {}, now = Date.now() }) {
  const state = { ...cached };
  const pending = new Map();
  const files = [];
  async function lookup(host) {
    const previous = state[host];
    const match = cachedPath.exec(previous?.path || "");
    if (match) {
      try {
        const bytes = await readFile(join(root, previous.path));
        if (imageDigest(bytes).slice(0, 16) === match[1]) return previous.path;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (previous?.path === null && previous.retryAfter > now) return null;
    try {
      // The service receives only the hostname, never profile paths or queries.
      const response = await fetcher(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok || Number(response.headers.get("content-length")) > 1024 * 1024) throw new Error("Favicon unavailable");
      const source = Buffer.from(await response.arrayBuffer());
      if (source.length > 1024 * 1024) throw new Error("Favicon too large");
      const input = sharp(source, { limitInputPixels: 1024 * 1024 });
      const metadata = await input.metadata();
      if (!["png", "jpeg", "webp", "gif", "avif"].includes(metadata.format)) throw new Error("Unsupported favicon");
      const bytes = await input.resize({ width: 64, height: 64, fit: "inside", withoutEnlargement: true }).webp().toBuffer();
      const path = `./images/members/favicons/${imageDigest(host).slice(0, 16)}-${imageDigest(bytes).slice(0, 16)}.webp`;
      files.push({ path, bytes });
      state[host] = { path };
      return path;
    } catch {
      state[host] = { path: null, retryAfter: now + retryDelay };
      return null;
    }
  }
  return {
    state, files,
    async links(urls = []) {
      return Promise.all(urls.map(async href => {
        const host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
        if (!pending.has(host)) pending.set(host, lookup(host));
        return { href, icon: await pending.get(host) };
      }));
    },
  };
}
