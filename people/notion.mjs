export const PEOPLE_DATA_SOURCE_ID = "140882c6-08ed-4e2a-9bcd-399ae6ba065b";
const text = parts => (parts || []).map(part => part.plain_text ?? part.text?.content ?? "").join("");
const sections = { "Executive Board": "executive-board", Representatives: "representatives" };
const uuid = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function publicProfile(page) {
  const p = page.properties || {};
  if (p.Publish?.checkbox !== true || page.archived || page.in_trash) return null;
  const name = text(p.Name?.title).trim();
  const role = p.Role?.select?.name;
  const section = sections[p.Section?.select?.name];
  const years = (p["Academic Year"]?.multi_select || []).map(option => {
    const match = /^(\d{4})[–-](\d{2}|\d{4})$/.exec(option.name);
    const start = Number(match?.[1]);
    const end = Number(match?.[2]);
    if (!match || (end !== start + 1 && end !== (start + 1) % 100)) throw new Error(`${name}: invalid Academic Year`);
    return start;
  });
  if (!uuid.test(page.id) || !name || !role || !section || !years.length) {
    throw new Error(`${name || page.id}: published profiles need Name, Role, Section and Academic Year`);
  }
  const graduationYear = p["Graduation Year"]?.number ?? null;
  if (graduationYear !== null && (!Number.isInteger(graduationYear) || graduationYear < 1900 || graduationYear > 2200)) {
    throw new Error(`${name}: invalid Graduation Year`);
  }
  const photos = p.Photo?.files || [];
  if (photos.length !== 1) throw new Error(`${name}: published profiles need exactly one Photo`);
  const photo = photos[0];
  const photoUrl = photo.file?.url || photo.external?.url;
  if (!photoUrl || new URL(photoUrl).protocol !== "https:") throw new Error(`${name}: Photo has no downloadable HTTPS URL`);
  const split = name.indexOf(" ");
  return {
    id: page.id.replaceAll("-", "").toLowerCase(), years: [...new Set(years)], photoUrl,
    member: {
      firstName: split < 0 ? name : name.slice(0, split),
      lastName: split < 0 ? "" : name.slice(split + 1),
      program: text(p.Program?.rich_text).trim() || null,
      graduationYear, role, section,
    },
  };
}

// Only the explicitly public section is imported. Never traverse work-item
// databases, editing notes, synced blocks or unrelated page content.
export function websiteBio(blocks) {
  let active = false;
  const paragraphs = [];
  for (const block of blocks) {
    if (block.archived || block.in_trash) continue;
    if (/^heading_[12]$/.test(block.type)) {
      if (active) break;
      active = text(block[block.type]?.rich_text).trim() === "Website Bio";
      continue;
    }
    if (!active) continue;
    if (["child_database", "child_page"].includes(block.type)) break;
    if (block.type !== "paragraph") {
      throw new Error("Website Bio must contain plain paragraphs; move other blocks outside that section");
    }
    if (block.has_children) throw new Error("Website Bio paragraphs must not contain nested blocks");
    const value = text(block.paragraph?.rich_text).trim();
    if (value) paragraphs.push(value);
  }
  return paragraphs;
}

export async function loadPeople(env, {
  fetcher = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  cachedProfiles = {},
  changedPageIds = [],
} = {}) {
  const token = env.NOTION_PEOPLE_TOKEN;
  if (!token) throw new Error("Set NOTION_PEOPLE_TOKEN to the read-only Team Directory connection token");
  const dataSource = env.NOTION_PEOPLE_DATA_SOURCE_ID || PEOPLE_DATA_SOURCE_ID;
  if (!uuid.test(dataSource)) throw new Error("Invalid NOTION_PEOPLE_DATA_SOURCE_ID");
  const headers = { Authorization: `Bearer ${token}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" };
  async function request(path, body) {
    await sleep(350);
    const response = await fetcher(`https://api.notion.com/v1/${path}`, {
      headers, method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000), redirect: "error",
    });
    // A failed run leaves the committed snapshot in place. Do not spend shared
    // quotas retrying here; the next scheduled reconciliation tries again.
    if (!response.ok) throw new Error(`Notion People request failed (HTTP ${response.status}); check connection access to Team Directory`);
    return response.json();
  }
  async function list(path, body) {
    const rows = [], cursors = new Set();
    let cursor;
    do {
      const pagination = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
      const result = body
        ? await request(path, { ...body, ...pagination })
        : await request(`${path}?${new URLSearchParams(pagination)}`);
      if (!Array.isArray(result.results) || result.request_status?.type === "incomplete") throw new Error("Incomplete Notion People response");
      rows.push(...result.results);
      cursor = result.has_more ? result.next_cursor : null;
      if (result.has_more && (!cursor || cursors.has(cursor))) throw new Error("Invalid Notion People pagination cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return rows;
  }
  const schema = await request(`data_sources/${dataSource}`);
  for (const [name, type] of Object.entries({ Name: "title", Publish: "checkbox", Role: "select", Section: "select", "Academic Year": "multi_select", "Graduation Year": "number", Program: "rich_text", Photo: "files" })) {
    if (schema.properties?.[name]?.type !== type) throw new Error(`Team Directory needs ${name} (${type})`);
  }
  const pages = await list(`data_sources/${dataSource}/query`, { filter: { property: "Publish", checkbox: { equals: true } } });
  const profiles = [], seen = new Set();
  const changed = new Set(changedPageIds.map(id => id.replaceAll("-", "").toLowerCase()));
  for (const page of pages) {
    const profile = publicProfile(page);
    if (!profile) continue;
    if (seen.has(profile.id)) throw new Error("Duplicate profile in Notion response");
    seen.add(profile.id);
    profile.lastEditedTime = typeof page.last_edited_time === "string" ? page.last_edited_time : null;
    const cached = cachedProfiles[profile.id];
    try {
      const unchanged = profile.lastEditedTime && profile.lastEditedTime === cached?.lastEditedTime && !changed.has(profile.id);
      profile.member.biography = unchanged && Array.isArray(cached?.biography) && cached.biography.every(value => typeof value === "string")
        ? [...cached.biography]
        : websiteBio(await list(`blocks/${page.id}/children`));
    } catch (error) { throw new Error(`${profile.member.firstName} ${profile.member.lastName}: ${error.message}`); }
    profiles.push(profile);
  }
  return profiles;
}
