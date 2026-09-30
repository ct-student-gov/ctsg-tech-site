import { NOTION_SOURCES, notionEvent } from "./sources.mjs";

const DAY = 86400000;
const uuid = /^[0-9a-f-]{32,36}$/i;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The repo stores only public event values, page versions, and a query cursor.
// Finished events live in the archive and are not individually polled.
export async function notionRepositorySource(source, env, state, archive, savedEvents, {
  now = new Date(), fetcher = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), changedPageIds = [],
} = {}) {
  if (!env.NOTION_TOKEN) throw new Error("Notion calendar token is not configured");
  const dataSource = env[source.setting] || source.dataSource;
  const old = state[source.id] || { versions: {}, cursor: null };
  const versions = { ...old.versions };
  const events = new Map(savedEvents.map(event => [event.id, event]));
  const history = new Map(archive.events(source.id).map(event => [event.id, event]));
  const known = new Map([...history, ...events]);
  async function request(path, body) {
    await sleep(350);
    const response = await fetcher(`https://api.notion.com/v1/${path}`, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404 && path.startsWith("pages/")) return null;
    if (!response.ok) throw new Error(`Notion calendar request failed (HTTP ${response.status})`);
    return response.json();
  }
  const pages = new Map(), cursors = new Set();
  const schema = await request(`data_sources/${dataSource}`);
  if (!["status", "select"].includes(schema.properties?.["Approval status"]?.type) || schema.properties?.Date?.type !== "date") {
    throw new Error("Notion calendar needs Approval status and Date properties");
  }
  let cursor;
  // No approval filter: a changed record with approval withdrawn must remove
  // its previously published value. A small overlap allows indexing delay.
  const filter = old.cursor ? { or: [
    { timestamp: "last_edited_time", last_edited_time: { on_or_after: new Date(Date.parse(old.cursor) - 5 * 60000).toISOString() } },
    { property: "Date", date: { on_or_after: new Date(+now - 2 * DAY).toISOString().slice(0, 10) } },
  ] } : undefined;
  do {
    const result = await request(`data_sources/${dataSource}/query`, {
      page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}),
    });
    if (!Array.isArray(result.results) || result.request_status?.type === "incomplete") throw new Error("Incomplete Notion calendar query");
    for (const page of result.results) pages.set(page.id, page);
    cursor = result.has_more ? result.next_cursor : null;
    if (result.has_more && (!cursor || cursors.has(cursor))) throw new Error("Invalid Notion calendar pagination");
    if (cursor) cursors.add(cursor);
  } while (cursor);

  // Detect deleted/moved upcoming events and long-running date ranges whose
  // start precedes the query window. Only explicit webhook hints fetch history.
  const inspect = new Set(changedPageIds.filter(id => uuid.test(id) && known.has(`notion:${id}`)));
  for (const event of known.values()) {
    if (Date.parse(event.end || event.start) >= +now - 2 * DAY) inspect.add(event.id.slice("notion:".length));
  }
  for (const id of inspect) if (!pages.has(id)) pages.set(id, await request(`pages/${id}`));

  let watermark = old.cursor || now.toISOString();
  for (const [id, page] of pages) {
    const eventId = `notion:${id}`;
    const edited = page?.last_edited_time;
    if (edited && Number.isFinite(Date.parse(edited)) && Date.parse(edited) > Date.parse(watermark)) watermark = edited;
    const parent = page?.parent?.data_source_id;
    const belongs = !parent || parent.replaceAll("-", "") === dataSource.replaceAll("-", "");
    const event = page && belongs ? notionEvent(page, source) : null;
    if (!event) {
      events.delete(eventId);
      delete versions[id];
      await archive.remove(source.id, eventId);
      continue;
    }
    if (!same(known.get(eventId), event)) {
      await archive.remove(source.id, eventId);
      events.set(eventId, event);
    }
    // Versions contain no properties from unpublished records.
    if (edited) versions[id] = edited;
  }
  state[source.id] = { cursor: watermark, versions };
  return { events: [...events.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

export const isNotionSource = id => NOTION_SOURCES.some(source => source.id === id);
