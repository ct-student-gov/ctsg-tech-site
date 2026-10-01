import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";

const imagePath = /^\.\/images\/(?:members|blog)\/notion\/\d{4}\/[a-f0-9]{32}-([a-f0-9]{16})\.(webp|svg)$/;

export const imageDigest = bytes => createHash("sha256").update(bytes).digest("hex");

// Another published profile or post may own the same image. Its filename still
// proves the expected bytes, without allowing arbitrary paths from sync state.
export async function readCachedImage(root, path, { allowSvg = false } = {}) {
  const match = imagePath.exec(typeof path === "string" ? path : "");
  if (!match || (match[2] === "svg" && !allowSvg)) return null;
  try {
    const bytes = await readFile(join(root, path));
    return imageDigest(bytes).slice(0, 16) === match[1] ? { path, bytes } : null;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

export function createImageCache(root) {
  const paths = new Map();
  let indexed;
  async function scan(directory) {
    let entries;
    try { entries = await readdir(join(root, directory), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = posix.join(directory, entry.name);
      if (entry.isDirectory()) await scan(relative);
      else if (entry.isFile()) {
        const image = await readCachedImage(root, `./${relative}`, { allowSvg: true });
        if (!image) continue;
        const digest = imageDigest(image.bytes);
        if (!paths.has(digest)) paths.set(digest, image.path);
      }
    }
  }
  return {
    async find(bytes) {
      // Unchanged syncs never scan unrelated files. Index only when a download
      // needs a destination, then reuse images prepared earlier in this run too.
      indexed ||= (async () => {
        await scan("images/members/notion");
        await scan("images/blog/notion");
      })();
      await indexed;
      return paths.get(imageDigest(bytes)) || null;
    },
    remember(path, bytes) {
      if (!imagePath.test(path)) throw new Error("Unexpected cached image path");
      paths.set(imageDigest(bytes), path);
    },
  };
}
