import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { parse } from "parse5";

const project = fileURLToPath(new URL("../", import.meta.url));
const siteBase = new URL("https://ct-student-gov.github.io/ctsg-tech-site/public/");
const raster = /\.(?:jpe?g|png|gif|tiff?|avif|heic|heif|bmp|webp)$/i;
const imageUrl = /\.(?:jpe?g|png|gif|tiff?|avif|heic|heif|bmp|webp|svg|ico)(?:[?#].*)?$/i;
const textExtensions = new Set([".html", ".css", ".js", ".json"]);
const maxDimension = 2048;

async function filesIn(root, directory = "") {
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const name = posix.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Image build does not allow symbolic links: ${name}`);
    if (entry.isDirectory()) files.push(...await filesIn(root, name));
    else files.push(name);
  }
  return files.sort();
}

// JS image paths are consumed by the document, not relative to the script.
function imageLocation(value, file) {
  if (!imageUrl.test(value)) return null;
  const base = file.endsWith(".js") ? siteBase : new URL(file, siteBase);
  const url = new URL(value, base);
  if (url.origin !== siteBase.origin || !url.pathname.startsWith(siteBase.pathname)) {
    return { external: true, url };
  }
  return { external: false, name: decodeURIComponent(url.pathname.slice(siteBase.pathname.length)), url };
}

function rewriteReferences(source, file, outputs) {
  const rewrite = value => {
    const location = imageLocation(value, file);
    if (!location || location.external) return value;
    const target = outputs.get(location.name);
    if (!target) throw new Error(`${file}: missing local image ${value}`);
    if (target === location.name) return value;
    if (target === location.name.replace(/\.[^.]+$/, ".webp")) return value.replace(/\.[^./?#]+(?=[?#]|$)/, ".webp");
    const url = new URL(target.split("/").map(encodeURIComponent).join("/"), siteBase);
    const suffix = location.url.search + location.url.hash;
    if (/^https?:\/\//.test(value)) return url.href + suffix;
    if (value.startsWith("//")) return `//${url.host}${url.pathname}${suffix}`;
    if (value.startsWith("/")) return url.pathname + suffix;
    const base = file.endsWith(".js") ? "" : posix.dirname(file);
    const path = posix.relative(base, target).split("/").map(part => part === ".." ? part : encodeURIComponent(part)).join("/");
    return `${value.startsWith("./") && !path.startsWith("../") ? "./" : ""}${path}${suffix}`;
  };
  // Quoted HTML attributes, JS strings, JSON fields, and CSS URLs.
  let result = source.replace(/(["'`])([^"'`\r\n]*)\1/g, (match, quote, value) => {
    // A srcset value may contain multiple URLs and width/density descriptors.
    const candidates = value.split(",");
    const candidatePattern = /^(\s*)(.*?\.(?:jpe?g|png|gif|webp|avif|svg)(?:[?#]\S*)?)(\s+\d+(?:\.\d+)?[wx])?(\s*)$/i;
    if ((candidates.length > 1 || /\s+\d+(?:\.\d+)?[wx]$/.test(value)) && candidates.every(item => candidatePattern.test(item))) {
      value = candidates.map(item => item.replace(candidatePattern, (_, space, url, size = "", trailing) => `${space}${rewrite(url)}${size}${trailing}`)).join(",");
    } else {
      value = rewrite(value);
    }
    return `${quote}${value}${quote}`;
  });
  if (/\.(css|html)$/.test(file)) {
    result = result.replace(/url\(\s*([^\s"')]+)\s*\)/gi, (_, value) => `url(${rewrite(value)})`);
  }
  // A <source type="image/jpeg"> must describe its converted srcset.
  if (file.endsWith(".html")) {
    result = result.replace(/<source\b[^>]*>/gi, tag => /srcset\s*=\s*["'][^"']*\.webp/i.test(tag)
      ? tag.replace(/\btype\s*=\s*(["'])image\/(?:jpeg|png|gif|tiff|avif)\1/gi, 'type="image/webp"') : tag);
  }
  return result;
}

function validateReference(value, file, files) {
  if (!value || value.startsWith("#")) return;
  const location = imageLocation(value, file);
  if (!location || !/\.(webp|svg)(?:[?#].*)?$/i.test(value)) {
    throw new Error(`${file}: use a local WebP photo or an SVG, not ${value}`);
  }
  // Existing externally hosted vector logos are allowed. Raster photos must be local.
  if (location.external) {
    if (/^https?:$/.test(location.url.protocol) && /\.svg$/i.test(location.url.pathname)) return;
    throw new Error(`${file}: download external photos into public/images before building: ${value}`);
  }
  if (!files.has(location.name)) throw new Error(`${file}: missing image ${value}`);
}

function validateRenderedReferences(source, file, files) {
  const check = value => validateReference(value, file, files);
  const srcset = value => value.split(",").forEach(item => check(item.trim().split(/\s+/)[0]));
  if (file.endsWith(".html")) {
    const visit = node => {
      const attrs = Object.fromEntries((node.attrs ?? []).map(attr => [attr.name, attr.value]));
      if (node.tagName === "img" || (node.tagName === "input" && attrs.type === "image")) {
        if (attrs.src) check(attrs.src);
        if (attrs.srcset) srcset(attrs.srcset);
      }
      if (node.tagName === "source" && attrs.srcset) srcset(attrs.srcset);
      if (node.tagName === "video" && attrs.poster) check(attrs.poster);
      if (node.tagName === "link" && /(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/.test(attrs.rel ?? "")) check(attrs.href);
      if (node.tagName === "meta" && /^(?:og:image(?::url)?|twitter:image)$/.test(attrs.property ?? attrs.name ?? "")) check(attrs.content);
      if (attrs.style) validateRenderedReferences(attrs.style, `${file}.css`, files);
      if (node.tagName === "style") validateRenderedReferences((node.childNodes ?? []).map(child => child.value ?? "").join(""), `${file}.css`, files);
      for (const child of node.childNodes ?? []) visit(child);
      if (node.content) visit(node.content);
    };
    visit(parse(source));
  } else if (file.endsWith(".css")) {
    for (const match of source.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
      if (imageUrl.test(match[2]) || /^data:image\//i.test(match[2])) check(match[2]);
    }
  } else if (["data/people.js", "data/blog.js"].includes(file)) {
    // Check fields actually rendered as images; retain portraitSource citations verbatim.
    for (const match of source.matchAll(/(?:["']?(?:portrait|src)["']?)\s*:\s*(["'])(.*?)\1/g)) {
      if (match[2]) check(match[2]);
    }
  }
}

export async function checkImages(root) {
  const names = await filesIn(root);
  const files = new Set(names);
  for (const name of names) {
    if (raster.test(name)) {
      if (extname(name).toLowerCase() !== ".webp") throw new Error(`Unconverted image in published output: ${name}`);
      const metadata = await sharp(join(root, name)).metadata();
      if (metadata.format !== "webp") throw new Error(`Not a real WebP image: ${name}`);
      if (metadata.width > maxDimension || (metadata.pageHeight ?? metadata.height) > maxDimension) throw new Error(`Oversized image: ${name}`);
    }
    if (/\.ico$/i.test(name)) throw new Error(`Use WebP or SVG for the favicon: ${name}`);
    if (textExtensions.has(extname(name))) validateRenderedReferences(await readFile(join(root, name), "utf8"), name, files);
  }
}

export async function buildSite({ source = join(project, "public"), output = join(project, "dist/public"), includeDemos = false } = {}) {
  if (resolve(output) === resolve(source) || resolve(source).startsWith(resolve(output) + "/") || resolve(output).startsWith(resolve(source) + "/")) throw new Error("Build output must be separate from the source directory");
  const names = (await filesIn(source)).filter(name => includeDemos || !name.startsWith("demo/"));
  const outputs = new Map();
  const owners = new Map();
  for (const name of names) {
    const target = raster.test(name) ? name.replace(/\.[^.]+$/, ".webp") : name;
    if (owners.has(target.toLowerCase())) throw new Error(`Image output collision: ${name} and ${owners.get(target.toLowerCase())}`);
    owners.set(target.toLowerCase(), name);
    outputs.set(name, target);
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  let converted = 0, deduplicated = 0;
  const imageHashes = new Map();
  // Resolve image aliases before rewriting page/data paths. Originals stay in
  // public/, while byte-identical published photos share one output file.
  for (const [name, target] of outputs) {
    if (!raster.test(name)) continue;
    const input = join(source, name);
    const metadata = await sharp(input).metadata();
    const unchanged = metadata.format === "webp" && metadata.width <= maxDimension && (metadata.pageHeight ?? metadata.height) <= maxDimension;
    const bytes = unchanged ? await readFile(input)
      : await sharp(input, { animated: true }).rotate().resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    if (!unchanged) converted++;
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (imageHashes.has(hash)) {
      outputs.set(name, imageHashes.get(hash));
      deduplicated++;
      continue;
    }
    imageHashes.set(hash, target);
    const destination = join(output, target);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  for (const [name, target] of outputs) {
    if (raster.test(name)) continue;
    const input = join(source, name);
    const destination = join(output, target);
    await mkdir(dirname(destination), { recursive: true });
    if (textExtensions.has(extname(name))) {
      await writeFile(destination, rewriteReferences(await readFile(input, "utf8"), name, outputs));
    } else {
      await copyFile(input, destination);
    }
  }
  await checkImages(output);
  return { converted, deduplicated, files: names.length - deduplicated };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--check") {
      await checkImages(join(project, "dist/public"));
      console.log("Published images and references passed validation.");
    } else {
      const result = await buildSite();
      // Keep the existing /public/ URLs used by WordPress and shared links.
      await writeFile(join(project, "dist/index.html"), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=./public/"><title>Cornell Tech Student Government</title></head><body><a href="./public/">Cornell Tech Student Government</a></body></html>\n');
      console.log(`Built dist/public: ${result.files} files, ${result.converted} images converted or resized.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
