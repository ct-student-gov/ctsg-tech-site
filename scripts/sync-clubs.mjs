import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadClubs } from "../clubs/notion.mjs";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));

export async function syncClubs({ env = process.env, root = publicRoot,
  statePath = join(dirname(root), "data-sync/clubs.json"), fetcher = fetch, sleep } = {}) {
  // Complete and validate the whole query before replacing any saved data.
  // A failed request or malformed published record preserves the last snapshot.
  const { clubs, dataSource } = await loadClubs(env, { fetcher, sleep });
  const files = [
    [join(root, "data/clubs.json"), `${JSON.stringify({ clubs }, null, 2)}\n`],
    [statePath, `${JSON.stringify({ dataSource }, null, 2)}\n`],
  ];
  let changed = false;
  for (const [path, source] of files) {
    let previous;
    try { previous = await readFile(path, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous === source) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, source);
    await rename(`${path}.tmp`, path);
    changed = true;
  }
  return { clubCount: clubs.length, changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await syncClubs();
    console.log(`Clubs: ${result.clubCount} published clubs; ${result.changed ? "updated" : "unchanged"}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
