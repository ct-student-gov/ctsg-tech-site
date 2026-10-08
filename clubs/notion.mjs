export const CLUBS_DATABASE_ID = "3ea0b1bd679180de868bc396ff9360c7";
export const JOIN_FIELD = "How will students join your club/receive club communications?";
export const LINKS_FIELD = "If your group already has a group chat or Slack channel, please provide the link here:";
const roles = ["President", "Vice President", "Treasurer", "Faculty/Staff Advisor"];
const uuid = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const text = parts => (parts || []).map(part => part.plain_text ?? part.text?.content ?? "").join("").trim();
const value = property => property?.url ?? text(property?.rich_text);

export function publicClub(page) {
  const p = page.properties || {};
  if (page.archived || page.in_trash || p.Publish?.checkbox !== true) return null;
  const name = text(p.Name?.title);
  if (!name || !uuid.test(page.id)) throw new Error("Published clubs need a Name and valid page ID");
  // Copy only the agreed public fields. Registration answers and page bodies
  // never enter the public snapshot or the repository's sync state.
  return {
    id: page.id.replaceAll("-", "").toLowerCase(), name,
    description: value(p.Description),
    officers: roles.flatMap(role => value(p[role]) ? [{ role, name: value(p[role]) }] : []),
    joining: value(p[JOIN_FIELD]),
    links: value(p[LINKS_FIELD]),
  };
}

export async function loadClubs(env, { fetcher = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!env.NOTION_CLUBS_TOKEN) throw new Error("Set NOTION_CLUBS_TOKEN to the read-only Clubs connection token");
  async function request(path, body) {
    await sleep(350);
    const response = await fetcher(`https://api.notion.com/v1/${path}`, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${env.NOTION_CLUBS_TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Notion Clubs request failed (HTTP ${response.status}); check connection access to Clubs`);
    return response.json();
  }
  let dataSource = env.NOTION_CLUBS_DATA_SOURCE_ID;
  if (!dataSource) {
    const database = await request(`databases/${CLUBS_DATABASE_ID}`);
    if (database.data_sources?.length !== 1) throw new Error("Set NOTION_CLUBS_DATA_SOURCE_ID to the Clubs data source");
    dataSource = database.data_sources[0].id;
  }
  if (!uuid.test(dataSource)) throw new Error("Invalid NOTION_CLUBS_DATA_SOURCE_ID");
  const schema = await request(`data_sources/${dataSource}`);
  const expected = { Name: ["title"], Publish: ["checkbox"], Description: ["rich_text"],
    ...Object.fromEntries(roles.map(role => [role, ["rich_text"]])),
    [JOIN_FIELD]: ["rich_text"], [LINKS_FIELD]: ["rich_text", "url"] };
  for (const [field, types] of Object.entries(expected)) {
    if (!types.includes(schema.properties?.[field]?.type)) throw new Error(`Clubs schema: ${field} must be ${types.join(" or ")}`);
  }
  const clubs = [], cursors = new Set(), ids = new Set();
  let cursor;
  do {
    const result = await request(`data_sources/${dataSource}/query`, {
      page_size: 100, filter: { property: "Publish", checkbox: { equals: true } },
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    if (!Array.isArray(result.results) || result.request_status?.type === "incomplete"
      || typeof result.has_more !== "boolean") throw new Error("Incomplete Notion Clubs response");
    for (const page of result.results) {
      const club = publicClub(page);
      if (!club) continue;
      if (ids.has(club.id)) throw new Error("Duplicate club in Notion response; retry the sync");
      ids.add(club.id); clubs.push(club);
    }
    cursor = result.has_more ? result.next_cursor : null;
    if (result.has_more && (typeof cursor !== "string" || !cursor || cursors.has(cursor))) throw new Error("Incomplete Notion Clubs pagination");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  clubs.sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id));
  return { clubs, dataSource };
}
