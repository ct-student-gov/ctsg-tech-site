# Cornell Tech Student Government website

The static CTSG site is hosted at [GitHub Pages](https://ct-student-gov.github.io/ctsg-tech-site/public/) and supports a fullscreen WordPress iframe with synchronized hash navigation. The main routes are About (`#/`), People (`#/members`), Events (`#/events`), and Governance (`#/by-laws`).

## Content updates

Notion is the editing source for People, Blog, and approved calendar events. GitHub Actions saves public snapshots and local images in this repository; visitors read those files without calling Notion. Edit content in the connected Notion databases rather than their generated snapshots.

- [People](docs/people.md): published Team Directory profiles and academic-year archives.
- [Blog](docs/blog.md): published posts, article bodies, image descriptions, and credits.
- [Calendar](docs/calendar.md): approved Notion events, Cornell feeds, and subscriptions.
- [Repository sync](docs/repository-sync.md) and [Notion notifications](docs/notion-webhook.md): credentials, update behavior, and maintenance.

The daily workflow runs at 00:43 UTC and also accepts manual syncs and signed Notion notifications. Unchanged imports skip publication. Failed imports or builds preserve the deployed site. Keep `data-sync/` state: it contains import caches and calendar history that may no longer exist upstream.

The first daily run of each UTC month also commits `data-sync/keepalive.txt` using the built-in `GITHUB_TOKEN`. This keeps public-repository schedules active during long periods without content changes or human edits. The keepalive runs before imports, needs no additional secret, and does not itself trigger a build or deployment.

## Run locally

Requires Node.js 20.9 or newer; CI uses Node.js 22.

```sh
npm ci
npm run dev
```

Open [the standalone site](http://localhost:8081/) or [the embed demos](http://localhost:8080/demo/). Port 8080 simulates the WordPress parent; port 8081 serves the child on a separate origin.

The development server builds at startup and on document reload, serving `dist/public/`. Reload after editing source files or adding photos. An image-build failure displays an error instead of a successful preview.

Previews read the published People, Blog, and calendar snapshots. A document reload clears their five-minute cache and bypasses the static host cache. Missing published photos are served from the hosted site; unavailable published files fall back to the built local copy. Code and styles come from this checkout. Normal previews require no Notion credentials and do not change local snapshots.

## Images and build

Put original photos under `public/images/`, including year subfolders where useful. Reference them with literal local paths in HTML, CSS, or People data, such as `./images/members/2030/jane-doe.jpg`. Download displayed photos locally; retain external URLs as source citations. Notion importers manage their own downloaded image folders.

```sh
npm run check
npm test
npm run build
npm run images:check
```

The build writes `dist/public/`. Raster photos become WebP at quality 82, fit within 2048 × 2048 without enlargement, and receive EXIF orientation correction. Newly encoded files have metadata stripped. Existing WebP files within the size limit are copied; SVGs remain vectors. Generated HTML, CSS, and JavaScript references point to the built images. Original files remain in `public/`.

Broken paths, invalid images, external rendered photos, unconverted raster output, and filename collisions stop validation. Use unique names: `jane-doe.jpg` and `jane-doe.webp` in one folder collide. Run both build and image validation after image changes. Do not hand-edit or commit `dist/`; publish validated output.

`.github/workflows/pages.yml` validates pull requests and publishes passing builds from `main`. GitHub Pages must use **GitHub Actions** as its deployment source. The uploaded `dist/` artifact retains the `/public/` URL and supplies a root redirect.

## WordPress embed

Use the hosted site URL, the `ctsg-site` iframe ID, and the bridge loaded after the iframe:

```html
<iframe
  id="ctsg-site"
  title="Cornell Tech Student Government"
  src="https://ct-student-gov.github.io/ctsg-tech-site/public/"
  style="position:fixed;inset:0;width:100%;height:100%;border:0;background:white;z-index:99999;"
></iframe>
<script src="https://ct-student-gov.github.io/ctsg-tech-site/public/wordpress-bridge.js" defer></script>
```

The bridge must execute in the WordPress parent document. It also updates the parent browser tab title from the iframe's current page title, such as `People | CTSG`; both `app.js` and `wordpress-bridge.js` must include title synchronization. The bridge also uses the iframe site's local favicon for the parent browser tab. It synchronizes the parent hash, deep links, reloads, and Back/Forward with the child. Without it, navigation works within the iframe but cannot update or read the cross-origin parent URL. Load the bridge once per page and verify the saved, published WordPress page; editor previews cannot establish script retention.

The static host must allow framing by `https://ctsg.tech.cornell.edu`; its framing headers and the parent's content security policy must permit the iframe and bridge. A sandboxed iframe needs `allow-scripts` and `allow-same-origin`. The child validates the parent origin against `allowedParents` in `public/app.js`; the bridge derives the child origin from the iframe URL. Hash routes require no server rewrite rules.

Use the local synchronized demo to check navigation, parent deep links, reloads, and Back/Forward. The iframe-only demo checks navigation without a bridge. `tests/bridge.test.mjs` covers message validation and history behavior; actual WordPress framing and script execution still require browser verification.
