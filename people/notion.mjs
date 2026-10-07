export const PEOPLE_DATA_SOURCE_ID = "140882c6-08ed-4e2a-9bcd-399ae6ba065b";
const text = parts => (parts || []).map(part => part.plain_text ?? part.text?.content ?? "").join("");
const sections = { "Executive Board": "executive-board", Representatives: "representatives" };
const selections = property => property?.multi_select ?? (property?.select ? [property.select] : []);
const uuid = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export class ProfileValidationError extends Error {}

export function publicContacts(properties) {
  const email = (properties.Email?.email ?? text(properties.Email?.rich_text)).trim();
  if (email && !/^[^\s@<>?&#%]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) {
    throw new ProfileValidationError("Email must contain one email address");
  }
  const links = [];
  for (const line of text(properties.Links?.rich_text).split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    let url;
    try { url = new URL(line); } catch {}
    if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new ProfileValidationError("Links must contain one complete HTTP(S) URL per line");
    }
    if (!links.includes(url.href)) links.push(url.href);
    if (links.length === 4) break;
  }
  return { ...(email ? { email } : {}), ...(links.length ? { links } : {}) };
}

export function publicProfile(page) {
  const p = page.properties || {};
  if (p.Publish?.checkbox !== true || page.archived || page.in_trash) return null;
  const name = text(p.Name?.title).trim();
  const roles = selections(p.Role).map(option => option.name);
  const selectedSections = selections(p.Section).map(option => sections[option.name]);
  const photos = p.Photo?.files || [];
  const missing = [!name && "Name", (!roles.length || roles.some(role => !role)) && "Role",
    (!selectedSections.length || selectedSections.some(section => !section)) && "Section",
    !p["Academic Year"]?.multi_select?.length && "Academic Year", photos.length !== 1 && "exactly one Photo"].filter(Boolean);
  if (missing.length) throw new ProfileValidationError(`${name || page.id}: needs ${missing.join(", ")}`);
  if (roles.length !== selectedSections.length) {
    throw new ProfileValidationError(`${name}: Role and Section need the same number of selections, paired in order`);
  }
  const assignments = roles.map((role, index) => ({ role, section: selectedSections[index] }));
  const years = (p["Academic Year"]?.multi_select || []).map(option => {
    const match = /^(\d{4})[–-](\d{2}|\d{4})$/.exec(option.name);
    const start = Number(match?.[1]);
    const end = Number(match?.[2]);
    if (!match || (end !== start + 1 && end !== (start + 1) % 100)) throw new ProfileValidationError(`${name}: invalid Academic Year`);
    return start;
  });
  if (!uuid.test(page.id) || !years.length) {
    throw new Error(`${name || page.id}: published profiles need Name, Role, Section and Academic Year`);
  }
  const graduationYear = p["Graduation Year"]?.number ?? null;
  if (graduationYear !== null && (!Number.isInteger(graduationYear) || graduationYear < 1900 || graduationYear > 2200)) {
    throw new ProfileValidationError(`${name}: invalid Graduation Year`);
  }
  const photo = photos[0];
  const photoUrl = photo.file?.url || photo.external?.url;
  let validPhotoUrl = false;
  try { validPhotoUrl = new URL(photoUrl).protocol === "https:"; } catch {}
  if (!validPhotoUrl) throw new ProfileValidationError(`${name}: Photo has no downloadable HTTPS URL`);
  const split = name.indexOf(" ");
  return {
    id: page.id.replaceAll("-", "").toLowerCase(), years: [...new Set(years)], photoUrl,
    assignments,
    member: {
      firstName: split < 0 ? name : name.slice(0, split),
      lastName: split < 0 ? "" : name.slice(split + 1),
      program: text(p.Program?.rich_text).trim() || null,
      graduationYear, ...assignments[0],
      ...publicContacts(p),
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
      throw new ProfileValidationError("Website Bio must contain plain paragraphs; move other blocks outside that section");
    }
    if (block.has_children) throw new ProfileValidationError("Website Bio paragraphs must not contain nested blocks");
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
  invalidProfiles = [],
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
  for (const [name, type] of Object.entries({ Name: "title", Publish: "checkbox", "Academic Year": "multi_select", "Graduation Year": "number", Program: "rich_text", Photo: "files" })) {
    if (schema.properties?.[name]?.type !== type) throw new Error(`Team Directory needs ${name} (${type})`);
  }
  for (const name of ["Role", "Section"]) {
    if (!["select", "multi_select"].includes(schema.properties?.[name]?.type)) {
      throw new Error(`Team Directory needs ${name} (select or multi_select)`);
    }
  }
  for (const [name, types] of Object.entries({ Email: ["rich_text", "email"], Links: ["rich_text"] })) {
    if (schema.properties?.[name] && !types.includes(schema.properties[name].type)) throw new Error(`Team Directory ${name} has an unsupported property type`);
  }
  const pages = await list(`data_sources/${dataSource}/query`, { filter: { property: "Publish", checkbox: { equals: true } } });
  const profiles = [], seen = new Set();
  const changed = new Set(changedPageIds.map(id => id.replaceAll("-", "").toLowerCase()));
  for (const page of pages) {
    if (page.properties?.Publish?.checkbox !== true || page.archived || page.in_trash) continue;
    if (!uuid.test(page.id)) throw new Error("Invalid profile ID in Notion response");
    const profileId = page.id.replaceAll("-", "").toLowerCase();
    if (seen.has(profileId)) throw new Error("Duplicate profile in Notion response");
    seen.add(profileId);
    let profile;
    try { profile = publicProfile(page); }
    catch (error) {
      if (!(error instanceof ProfileValidationError)) throw error;
      invalidProfiles.push({ id: profileId, message: error.message });
      continue;
    }
    if (!profile) continue;
    profile.lastEditedTime = typeof page.last_edited_time === "string" ? page.last_edited_time : null;
    const cached = cachedProfiles[profile.id];
    try {
      const unchanged = profile.lastEditedTime && profile.lastEditedTime === cached?.lastEditedTime && !changed.has(profile.id);
      profile.member.biography = unchanged && Array.isArray(cached?.biography) && cached.biography.every(value => typeof value === "string")
        ? [...cached.biography]
        : websiteBio(await list(`blocks/${page.id}/children`));
    } catch (error) {
      if (!(error instanceof ProfileValidationError)) throw error;
      invalidProfiles.push({ id: profileId, message: `${profile.member.firstName} ${profile.member.lastName}: ${error.message}` });
      continue;
    }
    profiles.push(profile);
  }
  return profiles;
}
