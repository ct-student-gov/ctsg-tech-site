import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { calendarData, memoryStorage, toICS } from "../calendar/service.mjs";
import { CalendarArchive } from "../calendar/archive.mjs";
import { NOTION_SOURCES, STUDENT_SOURCES } from "../calendar/sources.mjs";
import { notionRepositorySource } from "../calendar/repository.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const readJSON = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
};
async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}
const sorted = entries => Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
const cacheContent = cached => JSON.stringify({
  events: cached?.events, academicYear: cached?.academicYear, excludedCount: cached?.excludedCount || 0,
  warnings: cached?.coverage?.warnings || [],
});
const visible = data => JSON.stringify({
  events: data?.events,
  sources: data?.sources?.map(source => ({ id: source.id, name: source.name, state: source.state, archivedCount: source.archivedCount,
    warnings: source.coverage?.warnings?.map(({ code, message }) => ({ code, message })) })),
});

export async function syncCalendar({ env = process.env, root = project, now = new Date(), fetcher = fetch, sleep, changedPageIds = [], notionOnly = false } = {}) {
  const destination = join(root, "public/data/calendar.json");
  const statePath = join(root, "data-sync/calendar.json");
  const previous = await readJSON(destination, null);
  const state = await readJSON(statePath, { version: 1, live: {}, archive: {}, notion: {} });
  if (state.version !== 1) throw new Error("Unsupported calendar repository state");
  // Missing credentials must not silently remove an already-connected source.
  if (Object.keys(state.notion).length && !env.NOTION_TOKEN) throw new Error("Missing Notion calendar token");
  for (const source of STUDENT_SOURCES) {
    if (state.live[source.id] && !env[source.secret]) throw new Error(`Missing connection for ${source.name}`);
  }
  const storage = memoryStorage();
  const live = new Map(Object.entries(state.live));
  if (!live.size && previous) {
    for (const source of previous.sources) live.set(source.id, {
      events: previous.events.filter(event => event.source === source.id), updatedAt: source.updatedAt,
      // The public snapshot merges feed records (including student exports)
      // under their primary source. It preserves history, but cannot recreate
      // the individual feeds' coverage baselines; establish those on import.
      window: source.window, excludedCount: source.excludedCount || 0,
      ...(source.academicYear ? { academicYear: source.academicYear } : {}),
    });
  }
  for (const [id, data] of live) await storage.put(`calendar-v1:${id}`, JSON.stringify({
    ...data,
    // A committed repository baseline remains a valid count comparison even
    // after a quiet week. This timestamp is in memory only on unchanged runs.
    updatedAt: state.live[id] ? now.toISOString() : data.updatedAt || now.toISOString(),
  }));
  const archived = new Map(Object.entries(state.archive));
  const archive = new CalendarArchive({
    async list({ prefix }) { return new Map([...archived].filter(([key]) => key.startsWith(prefix))); },
    async put(key, value) { archived.set(key, value); },
    async delete(key) { archived.delete(key); },
  });
  await archive.load();
  const notionState = structuredClone(state.notion);
  // Serialize the three Notion tables under one token's rate limit.
  let pending = Promise.resolve();
  let notionError;
  const data = await calendarData(env, storage, { now, fetcher, forceRefresh: true, archive, notionOnly,
    notionLoader(source, savedEvents) {
      const definition = NOTION_SOURCES.find(item => item.id === source.id);
      const result = pending.then(() => notionRepositorySource(definition, env, notionState, archive, savedEvents, { now, fetcher, sleep, changedPageIds })).catch(error => { notionError ||= error; throw error; });
      // Stop after the first failure, especially 429; do not spend more requests.
      pending = result;
      return result;
    },
  });
  const failures = data.sources.filter(source => ["stale", "unavailable"].includes(source.state));
  if (failures.length) throw new Error(`Calendar sync failed: ${failures.map(source => source.name).join(", ")}. Saved files were not replaced.`, { cause: notionError });
  for (const source of data.sources) {
    if (source.state !== "current") continue;
    const cached = await storage.get(`calendar-v1:${source.id}`, "json");
    // Do not create a daily commit just to advance a last-checked timestamp.
    const next = { ...cached, events: [...cached.events].sort((a, b) => a.id.localeCompare(b.id)) };
    if (!state.live[source.id] || cacheContent(live.get(source.id)) !== cacheContent(next)) live.set(source.id, next);
  }
  const nextState = { version: 1, live: sorted(live), archive: sorted(archived), notion: sorted(Object.entries(notionState)) };
  const publicChanged = previous?.storage !== "repository" || visible(previous) !== visible(data);
  if (publicChanged) {
    data.storage = "repository";
    await writeJSON(destination, data);
    await writeFile(join(root, "public/data/calendar.ics"), toICS(data));
  }
  if (JSON.stringify(state) !== JSON.stringify(nextState)) await writeJSON(statePath, nextState);
  const warnings = data.sources.flatMap(source => (source.coverage?.warnings || []).map(warning => `${source.name}: ${warning.message}`));
  return { data: publicChanged ? data : previous, changed: publicChanged, warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await syncCalendar();
    console.log(`Calendar: ${result.data.events.length} saved events; ${result.changed ? "snapshot updated" : "unchanged"}.`);
    for (const warning of result.warnings) console.warn(warning);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
