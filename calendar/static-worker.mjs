// Keep the old class available during migration; its existing storage remains
// untouched. Public routes and schedules no longer invoke it.
export { CalendarProcessor } from "./worker.mjs";

export default {
  async fetch(request, env) {
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    const path = new URL(request.url).pathname;
    if (!["/api/calendar", "/api/calendar.ics"].includes(path)) return new Response("Not found", { status: 404, headers });
    const base = env.CALENDAR_SNAPSHOT_BASE_URL;
    let target;
    try {
      if (!base || new URL(base).protocol !== "https:") throw new Error("Invalid hosting URL");
      target = new URL(path.endsWith(".ics") ? "calendar.ics" : "calendar.json", base);
    } catch { return new Response("Snapshot hosting is not configured", { status: 503, headers }); }
    try {
      const upstream = await fetch(target, {
        method: request.method, signal: AbortSignal.timeout(15000), redirect: "manual",
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (!upstream.ok) throw new Error(`Snapshot HTTP ${upstream.status}`);
      return new Response(upstream.body, { headers: { ...headers, "Content-Type": path.endsWith(".ics") ? "text/calendar; charset=utf-8" : "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    } catch (error) {
      console.error("Calendar snapshot fetch failed", error instanceof Error ? error.message : "Unknown error");
      return new Response("Calendar snapshot unavailable", { status: 503, headers });
    }
  },
};
