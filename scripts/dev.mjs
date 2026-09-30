import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";
import { buildSite } from "./build.mjs";
import { calendarResponse, memoryStorage } from "../calendar/service.mjs";
import { CalendarArchive } from "../calendar/archive.mjs";
import { createPublishedPreview } from "./preview-data.mjs";

const root = fileURLToPath(new URL("../dist/public/", import.meta.url));
await buildSite();
let building = null;
const calendarStorage = memoryStorage();
const calendarArchive = new CalendarArchive();
// Preview published People/calendar/Blog data, with built local data as fallback.
// Opt into upstream imports only when developing the calendar importer.
const localCalendarSources = process.env.CALENDAR_LOCAL_SOURCES === "1";
const readPublished = createPublishedPreview();
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ics": "text/calendar; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

// Separate ports deliberately exercise cross-origin iframe messaging.
for (const port of [8080, 8081]) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      // A document reload is an explicit request for current published data.
      if (pathname.endsWith("/") || pathname.endsWith(".html")) readPublished.refresh();
      // Keep local code and styles while reading the published static data.
      // New content-addressed photos can be served before a local Git update.
      if (!pathname.startsWith("/images/") && !(localCalendarSources && pathname.startsWith("/api/calendar"))) {
        const published = await readPublished(pathname);
        if (published) {
          response.writeHead(published.status, Object.fromEntries(published.headers)).end(Buffer.from(await published.arrayBuffer()));
          return;
        }
      }
      if (pathname === "/api/calendar" || pathname === "/api/calendar.ics") {
        const result = localCalendarSources
          ? await calendarResponse(new Request(`http://localhost:${port}${request.url}`, { method: request.method }), process.env, calendarStorage, { archive: calendarArchive })
          : new Response(await readFile(resolve(root, pathname.endsWith(".ics") ? "data/calendar.ics" : "data/calendar.json")), { headers: { "Content-Type": pathname.endsWith(".ics") ? "text/calendar; charset=utf-8" : "application/json" } });
        response.writeHead(result.status, {
          "Content-Type": result.headers.get("Content-Type") || "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          ...(result.headers.has("Allow") ? { Allow: result.headers.get("Allow") } : {}),
        }).end(await result.text());
        return;
      }
      // Rebuild on document reload so local previews use the same images as production.
      if ((pathname.endsWith("/") || pathname.endsWith(".html")) && !building) {
        building = buildSite().finally(() => { building = null; });
      }
      try {
        if (building) await building;
      } catch (error) {
        console.error(error.message);
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(`Image build failed: ${error.message}`);
        return;
      }
      const path = resolve(root, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      let body;
      try { body = await readFile(path); }
      catch (error) {
        if (error.code === "ENOENT") {
          const published = await readPublished(pathname);
          if (published) {
            response.writeHead(published.status, Object.fromEntries(published.headers)).end(Buffer.from(await published.arrayBuffer()));
            return;
          }
        }
        throw error;
      }
      response.writeHead(200, {
        "Content-Type": types[extname(path)] || "application/octet-stream",
        "Cache-Control": "no-store",
      }).end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  server.on("error", (error) => {
    console.error(`Cannot serve port ${port}: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(port === 8080
      ? "Embed tests: http://localhost:8080/demo/"
      : "Standalone site: http://localhost:8081/");
  });
}
