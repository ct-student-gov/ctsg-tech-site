import { publishedCalendarSnapshot } from "../public/calendar-config.js";

const publishedBase = new URL("../", publishedCalendarSnapshot);
const cacheTime = 5 * 60 * 1000;
const snapshots = new Map([
  ["/data/people.js", "text/javascript; charset=utf-8"],
  ["/data/blog.js", "text/javascript; charset=utf-8"],
  ["/data/clubs.json", "application/json; charset=utf-8"],
  ["/data/calendar.json", "application/json; charset=utf-8"],
  ["/data/calendar.ics", "text/calendar; charset=utf-8"],
]);
const portrait = /^\/images\/members\/notion\/\d{4}\/[a-f\d]{32}-[a-f\d]{16}\.webp$/;
const blogImage = /^\/images\/blog\/notion\/\d{4}\/[a-f\d]{32}-[a-f\d]{16}\.(?:webp|svg)$/;
const favicon = /^\/images\/members\/favicons\/[a-f\d]{16}-[a-f\d]{16}\.webp$/;

// Development only: read already-published files without importing from Notion
// or changing the repository. Share requests/cache across both preview ports.
export function createPublishedPreview({ fetcher = fetch, now = Date.now } = {}) {
  const cache = new Map();
  async function readPublished(pathname) {
    const path = pathname.replace(/^\/api\/calendar(?:\.ics)?$/, value => value.endsWith(".ics") ? "/data/calendar.ics" : "/data/calendar.json");
    const type = snapshots.get(path);
    if (!type && !portrait.test(path) && !blogImage.test(path) && !favicon.test(path)) return null;
    async function download() {
      try {
        const url = new URL(path.slice(1), publishedBase);
        // Mutable snapshots must bypass the static host's ten-minute cache.
        // Immutable photo paths already change when their bytes change.
        if (type) url.searchParams.set("preview", String(now()));
        const response = await fetcher(url, {
          signal: AbortSignal.timeout(10000), redirect: "error", cache: "no-store",
        });
        if (!response.ok) return null;
        return new Uint8Array(await response.arrayBuffer());
      } catch { return null; }
    }
    let bytes;
    if (type) {
      let entry = cache.get(path);
      if (!entry || entry.expiresAt <= now()) {
        entry = { expiresAt: Infinity, pending: download() };
        cache.set(path, entry);
        entry.pending.finally(() => { entry.expiresAt = now() + cacheTime; });
      }
      bytes = await entry.pending;
    } else bytes = await download();
    if (!bytes) return null; // The dev server falls back to its built local copy.
    return new Response(bytes, { headers: {
      "Content-Type": type || (path.endsWith(".svg") ? "image/svg+xml" : "image/webp"),
      "Cache-Control": type ? "no-store" : "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    } });
  };
  readPublished.refresh = () => cache.clear();
  return readPublished;
}
