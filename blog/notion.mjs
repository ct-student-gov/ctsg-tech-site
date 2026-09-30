export const BLOG_DATA_SOURCE_ID = "3eb0b1bd-6791-80dd-87c6-000bc89419fd";
const uuid = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const text = parts => (parts || []).map(part => part.plain_text ?? part.text?.content ?? "").join("");
export class PostValidationError extends Error {}

function richText(parts = []) {
  return parts.map(part => {
    let href;
    try {
      const url = new URL(part.href || part.text?.link?.url);
      if (["http:", "https:", "mailto:"].includes(url.protocol)) href = url.href;
    } catch {}
    return { text: part.plain_text ?? part.text?.content ?? "", ...(href ? { href } : {}),
      ...Object.fromEntries(["bold", "italic", "strikethrough", "underline", "code"].filter(key => part.annotations?.[key]).map(key => [key, true])) };
  });
}

export function publicPost(page) {
  const p = page.properties || {};
  if (p.Publish?.checkbox !== true || page.archived || page.in_trash) return null;
  const title = text(p.Name?.title).trim();
  const date = p.Date?.date?.start?.slice(0, 10);
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new PostValidationError(`${title || page.id}: needs Name and a valid Date`);
  }
  const altText = text(p["Image Alt Text"]?.rich_text).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const creditsText = text(p["Image Credits"]?.rich_text);
  const credits = creditsText.trim() ? creditsText.split(/\r?\n/).map(value => value.trim()) : [];
  const files = p.Images?.files || [];
  if (altText.length !== files.length) throw new PostValidationError(`${title}: Image Alt Text needs one description per image, in Images order`);
  if (credits.length && credits.length !== files.length) throw new PostValidationError(`${title}: Image Credits needs one line per image, in Images order`);
  const photos = files.map((file, index) => {
    const url = file.file?.url || file.external?.url;
    try { if (new URL(url).protocol === "https:") return { url, alt: altText[index], credit: credits[index] || "" }; } catch {}
    throw new PostValidationError(`${title}: Images must have downloadable HTTPS URLs`);
  });
  return { id: page.id.replaceAll("-", "").toLowerCase(), title, date, photos,
    lastEditedTime: typeof page.last_edited_time === "string" ? page.last_edited_time : null };
}

export function articleBody(blocks) {
  const body = [];
  for (const block of blocks) {
    if (block.archived || block.in_trash) continue;
    // Embedded pages/databases are separate documents, never article content.
    if (["child_database", "child_page"].includes(block.type)) continue;
    if (!["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "quote", "code", "divider"].includes(block.type)) {
      throw new PostValidationError(`Unsupported article block ${block.type}; use text blocks and the Images property`);
    }
    if (block.has_children) throw new PostValidationError("Article text blocks must not contain nested blocks");
    body.push({ type: block.type, ...(block.type === "divider" ? {} : { richText: richText(block[block.type]?.rich_text) }) });
  }
  return body;
}

export async function loadBlog(env, {
  fetcher = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  cachedPosts = {}, changedPageIds = [], invalidPosts = [],
} = {}) {
  if (!env.NOTION_BLOG_TOKEN) throw new Error("Set NOTION_BLOG_TOKEN to the read-only Blog connection token");
  const dataSource = env.NOTION_BLOG_DATA_SOURCE_ID || BLOG_DATA_SOURCE_ID;
  if (!uuid.test(dataSource)) throw new Error("Invalid NOTION_BLOG_DATA_SOURCE_ID");
  async function request(path, body) {
    await sleep(350);
    const response = await fetcher(`https://api.notion.com/v1/${path}`, {
      headers: { Authorization: `Bearer ${env.NOTION_BLOG_TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
      method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000), redirect: "error",
    });
    if (!response.ok) throw new Error(`Notion Blog request failed (HTTP ${response.status}); check connection access to Blog`);
    return response.json();
  }
  async function list(path, body) {
    const rows = [], cursors = new Set();
    let cursor;
    do {
      const pagination = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
      const result = body ? await request(path, { ...body, ...pagination }) : await request(`${path}?${new URLSearchParams(pagination)}`);
      if (!Array.isArray(result.results) || result.request_status?.type === "incomplete") throw new Error("Incomplete Notion Blog response");
      rows.push(...result.results);
      cursor = result.has_more ? result.next_cursor : null;
      if (result.has_more && (!cursor || cursors.has(cursor))) throw new Error("Invalid Notion Blog pagination cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return rows;
  }
  const schema = await request(`data_sources/${dataSource}`);
  for (const [name, type] of Object.entries({ Name: "title", Publish: "checkbox", Date: "date", Images: "files", "Image Alt Text": "rich_text", "Image Credits": "rich_text" })) {
    if (schema.properties?.[name]?.type !== type) throw new Error(`Blog needs ${name} (${type})`);
  }
  const pages = await list(`data_sources/${dataSource}/query`, { filter: { property: "Publish", checkbox: { equals: true } } });
  const changed = new Set(changedPageIds.map(id => id.replaceAll("-", "").toLowerCase()));
  const posts = [], seen = new Set();
  for (const page of pages) {
    if (page.properties?.Publish?.checkbox !== true || page.archived || page.in_trash) continue;
    if (!uuid.test(page.id)) throw new Error("Invalid post ID in Notion response");
    const id = page.id.replaceAll("-", "").toLowerCase();
    if (seen.has(id)) throw new Error("Duplicate post in Notion response");
    seen.add(id);
    try {
      const post = publicPost(page);
      const cached = cachedPosts[id];
      post.body = post.lastEditedTime && post.lastEditedTime === cached?.lastEditedTime && !changed.has(id) && Array.isArray(cached.body)
        ? cached.body : articleBody(await list(`blocks/${page.id}/children`));
      posts.push(post);
    } catch (error) {
      if (!(error instanceof PostValidationError)) throw error;
      invalidPosts.push({ id, message: error.message });
    }
  }
  return posts;
}
