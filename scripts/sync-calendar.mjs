import { readFile, writeFile } from "node:fs/promises";
import { calendarData, memoryStorage, toICS } from "../calendar/service.mjs";

const destination = new URL("../public/data/calendar.json", import.meta.url);
const storage = memoryStorage();
try {
  const saved = JSON.parse(await readFile(destination, "utf8"));
  for (const source of saved.sources) {
    if (source.updatedAt) await storage.put(`calendar-v1:${source.id}`, JSON.stringify({ updatedAt: source.updatedAt, events: saved.events.filter(event => event.source === source.id), ...(source.academicYear ? { academicYear: source.academicYear } : {}) }));
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
// Only public feeds belong in a static fallback: a saved club approval could
// otherwise remain published indefinitely after it was withdrawn in Notion.
const data = await calendarData({}, storage, { forceRefresh: true });
await writeFile(destination, JSON.stringify(data, null, 2) + "\n");
await writeFile(new URL("../public/data/calendar.ics", import.meta.url), toICS(data));
for (const source of data.sources) console.log(`${source.name}: ${source.state}; ${data.events.filter(event => event.source === source.id).length} events`);
if (data.sources.some(source => source.state === "unavailable" || source.state === "stale")) process.exitCode = 1;
