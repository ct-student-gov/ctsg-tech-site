import { access, appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncCalendar } from "./sync-calendar.mjs";
import { syncPeople } from "./sync-people.mjs";
import { syncBlog } from "./sync-blog.mjs";
import { syncClubs } from "./sync-clubs.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
export function isRateLimit(error) {
  for (let current = error; current; current = current.cause) if (/HTTP 429\b/.test(current.message || "")) return true;
  return false;
}
export async function syncRepository({ env = process.env, root = project, now = new Date(), calendar = syncCalendar, people = syncPeople, blog = syncBlog, clubs = syncClubs } = {}) {
  const backoffPath = join(root, "data-sync/backoff.json");
  try {
    const backoff = JSON.parse(await readFile(backoffPath, "utf8"));
    if (Date.parse(backoff.until) > +now) return { skipped: true, rateLimited: false };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let event = {};
  if (env.GITHUB_EVENT_PATH) event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const triggered = env.GITHUB_EVENT_NAME === "repository_dispatch" && env.SYNC_FULL !== "true";
  const source = triggered ? event.client_payload?.source : null;
  if (triggered && !["calendar", "people", "blog", "clubs", "both", "multiple"].includes(source)) throw new Error("Unknown Notion notification source");
  let blogEnabled = !!env.NOTION_BLOG_TOKEN;
  try { await access(join(root, "data-sync/blog.json")); blogEnabled = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let clubsEnabled = !!env.NOTION_CLUBS_TOKEN;
  try { await access(join(root, "data-sync/clubs.json")); clubsEnabled = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const sources = source === "multiple" ? event.client_payload.sources
    : source === "both" ? ["calendar", "people"] : source ? [source]
      : ["calendar", "people", ...(blogEnabled ? ["blog"] : []), ...(clubsEnabled ? ["clubs"] : [])];
  if (!Array.isArray(sources) || !sources.length || sources.some(value => !["calendar", "people", "blog", "clubs"].includes(value))) throw new Error("Unknown Notion notification source");
  const id = event.client_payload?.page_id;
  const hints = Array.isArray(event.client_payload?.page_ids) ? event.client_payload.page_ids : [id];
  const changedPageIds = [...new Set(hints.filter(id => typeof id === "string" && /^[0-9a-f-]{32,36}$/i.test(id)))];
  // Require the two already-connected student feeds on complete scheduled runs.
  // Never silently publish a reduced calendar after a secret was missed.
  const required = [...(sources.includes("calendar") ? ["NOTION_TOKEN", "CAMPUSGROUPS_STUDENT_AFFAIRS_URL", "CAMPUSGROUPS_CAREER_MANAGEMENT_URL"] : []),
    ...(sources.includes("people") ? ["NOTION_PEOPLE_TOKEN"] : []), ...(sources.includes("blog") ? ["NOTION_BLOG_TOKEN"] : []),
    ...(sources.includes("clubs") ? ["NOTION_CLUBS_TOKEN"] : [])];
  for (const name of required) if (!env[name]) throw new Error(`Configure the GitHub Actions secret ${name} before enabling sync`);
  try {
    if (sources.includes("calendar")) {
      const result = await calendar({ env, root, now, changedPageIds, notionOnly: triggered });
      console.log(`Calendar: ${result.data.events.length} saved events; ${result.changed ? "updated" : "unchanged"}.`);
      for (const warning of result.warnings) console.warn(warning);
    }
    if (sources.includes("people")) {
      const result = await people({ env, root: join(root, "public"), changedPageIds });
      console.log(`People: ${result.profileCount} published profiles; ${result.downloadedPhotos} portrait downloads.`);
      for (const warning of result.warnings || []) console.warn(warning);
    }
    if (sources.includes("blog")) {
      const result = await blog({ env, root: join(root, "public"), changedPageIds });
      console.log(`Blog: ${result.postCount} published posts; ${result.downloadedPhotos} image downloads.`);
      for (const warning of result.warnings || []) console.warn(warning);
    }
    if (sources.includes("clubs")) {
      const result = await clubs({ env, root: join(root, "public") });
      console.log(`Clubs: ${result.clubCount} published clubs; ${result.changed ? "updated" : "unchanged"}.`);
    }
    await rm(backoffPath, { force: true });
    return { skipped: false, rateLimited: false };
  } catch (error) {
    if (isRateLimit(error)) {
      // Notion's connections share the same conservative cooldown. A failed
      // workflow commits only this marker, never its partially prepared data.
      const until = new Date(now); until.setUTCHours(24, 0, 0, 0);
      await mkdir(dirname(backoffPath), { recursive: true });
      await writeFile(backoffPath, JSON.stringify({ until: until.toISOString() }, null, 2) + "\n");
      if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, "rate_limited=true\n");
    }
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await syncRepository();
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `skipped=${result.skipped}\n`);
    if (result.skipped) console.log("Notion sync deferred until the next UTC day after a rate limit.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
