import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript" };

// Separate ports deliberately exercise cross-origin iframe messaging.
for (const port of [8080, 8081]) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const path = resolve(root, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const body = await readFile(path);
      response.writeHead(200, {
        "Content-Type": `${types[extname(path)] || "application/octet-stream"}; charset=utf-8`,
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
