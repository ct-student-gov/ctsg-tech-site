import { calendarData, calendarResponse } from "./service.mjs";

// SQLite-backed Durable Objects are available on Workers Free and have a
// 30-second CPU budget. Parsing belongs here, not in the 10-ms edge Worker.
export class CalendarProcessor {
  constructor(state, env) {
    this.env = env;
    this.pending = Promise.resolve();
  }

  fetch(request) {
    // Serialize refreshes to avoid duplicate imports and KV writes when
    // visitors arrive together at the cache expiry boundary.
    const result = this.pending.then(() => this.respond(request));
    this.pending = result.catch(() => {});
    return result;
  }

  async respond(request) {
    const env = this.env;
    if (!env.CALENDAR_CACHE) throw new Error("Calendar storage is not configured");
    if (request.method !== "POST" || new URL(request.url).pathname !== "/refresh") {
      return calendarResponse(request, env, env.CALENDAR_CACHE);
    }
    const data = await calendarData(env, env.CALENDAR_CACHE, { now: new Date(await request.text()), forceRefresh: true });
    const failed = data.sources.filter(source => ["stale", "unavailable"].includes(source.state));
    // calendarData retains valid cached events; fail the scheduled invocation
    // visibly so a source outage never masquerades as a successful refresh.
    if (failed.length) return new Response(`Calendar refresh failed: ${failed.map(source => source.name).join(", ")}`, { status: 502 });
    return new Response("Calendar refreshed");
  }
}

const processor = env => env.CALENDAR_PROCESSOR.get(env.CALENDAR_PROCESSOR.idFromName("calendar"));

export default {
  async scheduled(controller, env) {
    if (!env.CALENDAR_PROCESSOR) throw new Error("Calendar processor is not configured");
    const response = await processor(env).fetch(new Request("https://calendar.internal/refresh", { method: "POST", body: new Date(controller.scheduledTime).toISOString() }));
    if (!response.ok) throw new Error(await response.text());
  },
  async fetch(request, env) {
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET" } });
    // The force-refresh route is reachable only through the internal binding.
    if (!["/api/calendar", "/api/calendar.ics"].includes(new URL(request.url).pathname)) return new Response("Not found", { status: 404, headers });
    if (!env.CALENDAR_PROCESSOR) return new Response("Calendar processor is not configured", { status: 503, headers });
    return processor(env).fetch(request);
  },
};
