import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";
import { buildSite } from "./build.mjs";
import { calendarResponse, memoryStorage } from "../calendar/service.mjs";

const root = fileURLToPath(new URL("../dist/public/", import.meta.url));
await buildSite();
let building = null;
const calendarStorage = memoryStorage();
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
      if (pathname === "/api/calendar" || pathname === "/api/calendar.ics") {
        const result = await calendarResponse(new Request(`http://localhost:${port}${request.url}`, { method: request.method }), process.env, calendarStorage);
        response.writeHead(result.status, Object.fromEntries(result.headers)).end(await result.text());
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
      const body = await readFile(path);
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
