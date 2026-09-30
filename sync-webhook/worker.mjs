const REPOSITORY = "ct-student-gov/ctsg-tech-site";
const MAX_BODY_BYTES = 64 * 1024;
const DUPLICATE_TTL_MS = 25 * 60 * 60 * 1000;
const MAX_RECENT_EVENTS = 512;
const BATCH_INTERVAL_MS = 5 * 60 * 1000;
const CONNECTIONS = {
  "/notion/calendar": { source: "calendar", secret: "NOTION_CALENDAR_WEBHOOK_SECRET" },
  "/notion/people": { source: "people", secret: "NOTION_PEOPLE_WEBHOOK_SECRET" },
  "/notion/blog": { source: "blog", secret: "NOTION_BLOG_WEBHOOK_SECRET" },
};
const EVENTS = new Set([
  "page.created", "page.properties_updated", "page.content_updated",
  "page.moved", "page.deleted", "page.undeleted",
  "data_source.schema_updated", "data_source.moved", "data_source.deleted", "data_source.undeleted",
  "database.moved", "database.deleted", "database.undeleted",
]);
const UUID = /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i;

function reply(status, message) {
  return new Response(message ?? null, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function limitedBody(request) {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function validSignature(body, signature, secret) {
  if (!secret || !/^sha256=[a-f\d]{64}$/i.test(signature ?? "")) return false;
  const supplied = Uint8Array.from(signature.slice(7).match(/../g), byte => Number.parseInt(byte, 16));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  // Web Crypto performs the comparison without a JavaScript string comparison.
  return crypto.subtle.verify("HMAC", key, supplied, body);
}

function dispatchPayload(event, source) {
  const entityType = event.type.split(".")[0];
  if (typeof event.id !== "string" || !UUID.test(event.id) ||
      typeof event.entity?.id !== "string" || !UUID.test(event.entity.id) ||
      event.entity?.type !== entityType || typeof event.timestamp !== "string" ||
      !Number.isFinite(Date.parse(event.timestamp))) return null;
  return {
    event_type: "notion-updated",
    client_payload: {
      source,
      event_id: event.id,
      event_type: event.type,
      entity_id: event.entity.id,
      entity_type: entityType,
      timestamp: new Date(event.timestamp).toISOString(),
      ...(entityType === "page" ? { page_id: event.entity.id } : {}),
    },
  };
}

export function createWebhookHandler({ now = Date.now } = {}) {
  // Best effort only: isolates can restart or receive events in different regions.
  // The GitHub job always reconciles from saved state, so duplicate runs are safe.
  const recent = new Map();
  return async function handle(request, env) {
    const connection = CONNECTIONS[new URL(request.url).pathname];
    if (!connection) return reply(404, "Not found");
    if (request.method !== "POST") {
      const response = reply(405, "Method not allowed");
      response.headers.set("Allow", "POST");
      return response;
    }
    if (!env[connection.secret] || !env.GITHUB_DISPATCH_TOKEN || !env.SYNC_QUEUE) return reply(503, "Relay not configured");
    let body;
    try { body = await limitedBody(request); } catch { return reply(400, "Invalid request body"); }
    if (body === null) return reply(413, "Request too large");
    if (!await validSignature(body, request.headers.get("x-notion-signature"), env[connection.secret])) {
      return reply(401, "Invalid signature");
    }
    let event;
    try { event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch {
      return reply(400, "Invalid event");
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return reply(400, "Invalid event");
    if (!EVENTS.has(event.type)) return reply(204);
    const payload = dispatchPayload(event, connection.source);
    if (!payload) return reply(400, "Invalid event");

    const time = now();
    for (const [key, value] of recent) if (value.expiresAt <= time) recent.delete(key);
    const key = `${connection.source}:${event.id}`;
    let record = recent.get(key);
    if (!record) {
      while (recent.size >= MAX_RECENT_EVENTS) recent.delete(recent.keys().next().value);
      record = {
        expiresAt: time + DUPLICATE_TTL_MS,
        delivery: (async () => {
          try {
            const queue = env.SYNC_QUEUE.get(env.SYNC_QUEUE.idFromName("notion-updates"));
            const response = await queue.fetch("https://queue.internal/", {
              method: "POST", body: JSON.stringify(payload.client_payload),
            });
            return response.status === 202;
          } catch { return false; }
        })(),
      };
      recent.set(key, record);
    }
    if (!await record.delivery) {
      if (recent.get(key) === record) recent.delete(key);
      // Non-2xx keeps Notion's delivery retry active, including during GitHub limits.
      return reply(502, "Sync queue unavailable");
    }
    return reply(202, "Accepted");
  };
}

// All connections share one persistent queue, so a new isolate cannot bypass
// the five-minute interval. Only routing hints are stored, never content.
export class NotionSyncQueue {
  constructor(ctx, env, { fetcher = fetch, now = Date.now } = {}) {
    this.ctx = ctx;
    this.env = env;
    this.fetcher = fetcher;
    this.now = now;
  }

  async fetch(request) {
    if (request.method !== "POST") return reply(405, "Method not allowed");
    let hint;
    try { hint = await request.json(); } catch { return reply(400, "Invalid hint"); }
    if (!hint || !["calendar", "people", "blog"].includes(hint.source) ||
        (hint.page_id !== undefined && (typeof hint.page_id !== "string" || !UUID.test(hint.page_id)))) return reply(400, "Invalid hint");
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.transaction(async () => {
        const storage = this.ctx.storage;
        const state = await storage.get("batch") || { sources: [], pageIds: [], nextDispatchAt: 0 };
        const ids = new Set(state.pageIds);
        if (hint.page_id) ids.add(hint.page_id);
        if (ids.size > MAX_RECENT_EVENTS) throw new Error("Sync batch is full");
        state.sources = [...new Set([...state.sources, hint.source])].sort();
        state.pageIds = [...ids].sort();
        // Keep the first deadline: ongoing typing cannot postpone publication
        // indefinitely, and the final edit always remains queued.
        state.readyAt ??= Math.max(this.now() + BATCH_INTERVAL_MS, state.nextDispatchAt);
        await storage.put("batch", state);
        await storage.setAlarm(Math.max(state.readyAt, state.nextDispatchAt));
      });
      return reply(202, "Queued");
    });
  }

  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get("batch");
      if (!state?.sources.length) return;
      const due = Math.max(state.readyAt, state.nextDispatchAt);
      if (this.now() < due) {
        await this.ctx.storage.setAlarm(due);
        return;
      }
      // Persist the interval and retry alarm before sending. Even a crash or
      // an ambiguous GitHub response cannot cause another rapid dispatch.
      state.nextDispatchAt = this.now() + BATCH_INTERVAL_MS;
      await this.ctx.storage.transaction(async () => {
        const storage = this.ctx.storage;
        await storage.put("batch", state);
        await storage.setAlarm(state.nextDispatchAt);
      });
      let accepted = false;
      try {
        const response = await this.fetcher(`https://api.github.com/repos/${REPOSITORY}/dispatches`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.GITHUB_DISPATCH_TOKEN}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "ctsg-notion-sync",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ event_type: "notion-updated", client_payload: {
            source: state.sources.length === 1 ? state.sources[0] : state.sources.includes("blog") ? "multiple" : "both",
            ...(state.sources.includes("blog") && state.sources.length > 1 ? { sources: state.sources } : {}),
            page_ids: state.pageIds,
          } }),
          signal: AbortSignal.timeout(8000), redirect: "manual",
        });
        accepted = response.status === 204;
      } catch {}
      if (!accepted) return; // The persisted alarm retries this batch in five minutes.
      await this.ctx.storage.transaction(async () => {
        const storage = this.ctx.storage;
        await storage.put("batch", { sources: [], pageIds: [], nextDispatchAt: state.nextDispatchAt });
        await storage.deleteAlarm();
      });
    });
  }
}

export default { fetch: createWebhookHandler() };
