# Cornell Tech Student Government website

This repository will contain the custom CTSG website, hosted outside Cornell’s restricted WordPress environment and embedded at **https://ctsg.tech.cornell.edu/** in a fullscreen iframe.

The HTML/JavaScript site uses the composed Cornell editorial homepage. It retains hash navigation and the WordPress iframe bridge. The browser runtime has no dependencies; the build uses Sharp to prepare WebP images. The year-based People gallery is on `#/members`.

## Updating People

Edit `public/data/people.js` to maintain the gallery. Add an entry to `years` with a numeric `startYear` and a `members` array; the page automatically shows the newest year first and labels it, for example, `2026–2027`. Keep previous entries to retain the archive. Each person has `firstName`, `lastName`, `program`, `graduationYear`, and a `portrait` path relative to `public/`. Set each person’s `section` to `executive-board` or `representatives` to place them in the corresponding gallery within their year. Each portrait area uses Cornell red behind the picture, name, and role, extending halfway into the gap to its border. Expanded details use the page background. Borders follow each profile’s own height. Unfilled positions appear as TBD cards with their role. Click a member’s portrait or name to expand an integrated profile: their program, known graduation year, biography, and fun fact wrap beside the portrait and its labels, then continue across the full card width below. On narrow screens, the details stack below the portrait for readability. A border fades in and out on hover over 0.125 seconds. One animated box surrounds the picture, name, position, and details; the red area, portrait, name, and position slide together to the right side as the box expands and return to their gallery positions as it shrinks. Move the mouse off the expanded card, click outside it, or press Escape to dismiss it. Reduced-motion preferences disable the animation. TBD entries and past members without biographies have no detail box. The 2025–2026 roster comes from https://ctsg.tech.cornell.edu/sample-page/past-members/, supplemented with biographies and portraits from the September 2025 and February 2026 homepage revisions. The 2024–2025 roster comes from the November 2024 revision. Recovered portraits are stored locally under `public/images/members/` (or reuse existing local images); each imported profile retains its source revision and portrait URL. Nathan Tai’s September 2025 ORIE role is dated to distinguish it from the later representative. Missing portraits use `public/images/members/no-image.svg`, and missing biographies stay empty.

Full degree titles and graduation years appear together. For the existing rosters, one-year programs use the roster’s ending year; two-year programs use supplied graduation years or first-/second-year cohort labels. Keep years `null` (displayed as “Year TBD”) when the program or cohort is unknown. When adding a roster, supply the appropriate graduation years in the data. Set `banner.src` to the group photo path and update `banner.alt` to replace the placeholder. No page markup changes are needed to add years or people.

## Adding photos (including future years)

1. Put the original photo in `public/images/`, using year folders where useful, such as `public/images/members/2030/jane-doe.jpg`.
2. Reference that original file with a literal path in the HTML, CSS, or `public/data/people.js`, such as `"./images/members/2030/jane-doe.jpg"`. Download externally hosted photos into this directory first. Do not construct image filenames dynamically in JavaScript.
3. Run `npm run dev` to preview, or `npm run build` to prepare publishing files. The build scans every subfolder, so future years require no build configuration changes.

The build preserves originals in `public/` and writes the site to **`dist/public/`**. It converts raster photos to WebP at quality 82, fits them within 2048 × 2048 without enlarging small images, applies EXIF orientation, and strips metadata from newly encoded files. Existing WebP files within the size limit are copied without re-encoding. SVGs stay SVGs. HTML, CSS, and JavaScript image references are updated in the generated output, including People portraits and the group banner. Original external source citations are retained.

Use unique photo names: `jane-doe.jpg` and `jane-doe.webp` in the same folder would collide and stop the build. Broken image paths, invalid images, unconverted raster files, and external photos in rendered HTML/CSS/People fields also fail validation. Use literal image paths so the build can inspect them; third-party iframe content is outside this site's image pipeline.

`npm run images:check` validates an existing `dist/public/` output. Do not edit or commit `dist/`; it is generated. Only publish built output, never the original `public/` folder.

### Enabling the publishing gate on GitHub Pages

`.github/workflows/pages.yml` runs syntax checks, tests, the image build, and final image validation. Pull requests only validate; pushes to `main` and manual runs on `main` publish the validated artifact after every check passes. The artifact preserves the current `/public/` URL, including the WordPress embed and social preview image paths. Its root links/redirects to `/public/`.

**After the workflow and build files are committed and pushed, set Settings → Pages → Build and deployment → Source to GitHub Actions**, then run the workflow if needed. A Pages configuration that publishes directly from a branch bypasses the image checks; merely adding the workflow does not change that setting. See [GitHub's custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Styling

- `public/styles/global.css`: shared colors, typography, header/footer, and reusable title and tile patterns.
- `public/styles/home.css`: homepage layout, aligned feature rows, portraits, and square governance tile.
- `public/styles/members.css`: centered, responsive People gallery with up to five columns.

The Student Life image and its title are grouped in one figure for a future event carousel. There is currently one static event; carousel controls and rotation are not implemented.

## Current site review

Reviewed the public site on September 23, 2026:

| Existing page | Observed content | Prototype route |
| --- | --- | --- |
| [CTSG homepage](https://ctsg.tech.cornell.edu/) | About/mission, executive board profiles, master’s program representatives; several roles marked TBD | `#/` and `#/members` |
| [Student Events](https://ctsg.tech.cornell.edu/studentevents/) | Club Fair heading and image gallery | `#/events` |
| [Past Members](https://ctsg.tech.cornell.edu/sample-page/past-members/) | ’26 executive board and cohort representative roster | `#/past-members` |
| [CTSG By-Laws](https://ctsg.tech.cornell.edu/sample-page/ctsg-by-laws/) | By-Laws v4.2, articles, revision history, and table-of-contents links to Google Docs | `#/by-laws` |

The reviewed public site's navigation has CTSG and Student Events at the top, with Past Members and By-Laws under CTSG. Its homepage mixes the introduction and member directory into one long page. The local site separates the homepage and member directory and uses the downloaded member and Club Fair photos. `#/clubs` and `#/clubs/example` remain placeholder/test pages, not a directory found on the reviewed site. By-laws have not been migrated.

## Run locally

Requires Node.js 20.9 or newer (Node.js 22 is used in CI). Install the locked build dependencies once:

```sh
npm ci
npm run dev
```

The development server builds the site at startup and on each document reload, and serves `dist/public/`. Reload after editing source files or adding photos. A failed image build displays an error instead of a successful preview.

Open **http://localhost:8080/demo/**. The development server exposes two different origins:

- `http://localhost:8080` simulates the WordPress parent page.
- `http://localhost:8081` serves the custom site inside the iframe.

The localhost preview reads the latest published People, calendar, and Blog files automatically when requested. Each document reload rechecks published data immediately and bypasses the static host cache; background requests share a five-minute cache. Reload the page to refresh People and Blog; the calendar also refreshes while open. New photos missing locally are served from the published site. This does not call Notion, trigger sync workflows, or alter local source files. If the published site is unavailable, the preview falls back to the built local copy. Code and styling continue to come from this checkout.

The demo includes a synchronized fullscreen embed, a nested deep link, an iframe-only embed, and a standalone link. All modes use the same site styles.

```sh
npm run check
npm test
```

## What WordPress must allow

**Allowing an iframe alone does not allow parent URL synchronization.** A small bridge script must also execute in the WordPress parent document. The iframe cannot change the cross-origin parent’s URL by itself; `postMessage` only delivers messages to an installed listener.

| Capability | Iframe only | Iframe plus parent bridge |
| --- | --- | --- |
| Navigate within the custom site | Yes | Yes |
| Update the visible Cornell URL to `#/clubs` | No | Yes |
| Open/reload a Cornell hash deep link | No; parent hash cannot be read by the child | Yes |
| Back/Forward | Child history may be traversed; Cornell URL stays unchanged | Parent route and iframe stay synchronized |

Public-page inspection cannot establish whether the WordPress editor preserves script tags, whether an administrator can install the bridge, or whether production security policies permit it. Test the saved, published page: editor previews are not sufficient. If scripts are stripped, the iframe-only mode still works; share direct hosted-site links for deep links until an administrator enables the parent bridge.

## WordPress embed

### Quick test on the existing WordPress testing page

The public [testing page](https://ctsg.tech.cornell.edu/testing/) currently embeds `https://ct-student-gov.github.io/ctsg-tech-site/`. That address serves the rendered README; the actual prototype is at [the public directory](https://ct-student-gov.github.io/ctsg-tech-site/public/). When inspected, the WordPress iframe also had no `ctsg-site` ID and no bridge script.

1. Copy all of [docs/wordpress-bridge-test.html](docs/wordpress-bridge-test.html) into the WordPress HTML editor, **replacing the entire previous test block** on the testing page. It includes the corrected hosted URL ending in `/public/`, the matching iframe ID, a diagnostic label, a one-line script probe, and the externally hosted bridge. Do not also paste the bridge code inline.
2. Save and open the actual [testing page](https://ctsg.tech.cornell.edu/testing/) outside the editor. The temporary status line is at the bottom of the viewport, above the fullscreen iframe.
3. Click Clubs. The address should become `https://ctsg.tech.cornell.edu/testing/#/clubs`. Reload, then test Back/Forward.

| Status | Meaning |
| --- | --- |
| Parent script has not run | The label appeared but JavaScript has not executed. Inspect the saved HTML for removed scripts and the browser console for blocking/errors; this message alone does not identify the cause. |
| Parent JavaScript ran | The one-line probe executed. Check the iframe’s own Mode: “parent URL sync connected” confirms the bridge handshake. The currently deployed bridge may leave this probe label unchanged. |
| Bridge script running, but no iframe… | The iframe needs the matching ID and must precede the script. |
| Bridge script running; waiting… | Parent JavaScript works; verify the child app and its allowed parent origins. |
| Iframe detected | A valid message arrived from the iframe. Click a link to complete the test. |
| URL synchronization active | The iframe requested navigation and the parent updated its hash. Still verify reload and Back/Forward. |

If no label appears, inspect whether WordPress preserved the fragment. Restore the original iframe block to undo the test. The snippet loads the already deployed bridge and does not require a new deployment. Later deployments of the bridge with optional diagnostics can show the additional status messages listed above. Regenerate the snippet with `npm run wordpress:test-snippet`.

On retesting the first inline version, WordPress retained the script tag but inserted `<p>`/`</p>` markup and changed `&&` to `&#038;&#038;` inside the JavaScript. The prototype loaded, but its Mode reported no parent bridge and the probe remained unchanged. The current snippet loads JavaScript from an external file to avoid that content formatting. Its behavior on WordPress still needs verification after replacing the old block.

### Hosted setup

Run `npm run build` and `npm run images:check`, then deploy the contents of `dist/public/` to a static HTTPS host. The supplied GitHub Pages workflow instead uploads `dist/` to retain the existing `/public/` URL. Replace `https://YOUR-HOST.example/` below with the actual deployed site URL, including a repository subpath if applicable. This placeholder URL is not a deployment. Demo files are for local testing and can be excluded from deployment.

Paste the iframe into the WordPress page’s allowed HTML block:

```html
<link rel="preconnect" href="https://YOUR-HOST.example">
<link rel="dns-prefetch" href="https://YOUR-HOST.example">
<iframe
  id="ctsg-site"
  title="Cornell Tech Student Government"
  src="https://YOUR-HOST.example/"
  style="position:fixed;inset:0;width:100%;height:100%;border:0;background:white;z-index:99999;"
></iframe>
```

If WordPress allows parent scripts, add this **after the iframe**, or have the site administrator load it through an approved WordPress mechanism:

```html
<script src="https://YOUR-HOST.example/wordpress-bridge.js" defer></script>
```

The externally hosted script still executes in the parent document when loaded this way. Putting it inside the iframe will not work. Keep the `ctsg-site` ID, and load the bridge once per page. If WordPress changes the iframe attributes or adds sandbox restrictions, JavaScript and a non-opaque child origin must remain available (`allow-scripts` and `allow-same-origin` if sandboxed).

The static host must permit framing by `https://ctsg.tech.cornell.edu`: do not send `X-Frame-Options: DENY` or `SAMEORIGIN`, and ensure any CSP `frame-ancestors` permits the Cornell origin. The parent’s CSP must also permit the hosted iframe and bridge script. CORS headers are not needed for this messaging protocol. Fullscreen positioning should be checked on the actual WordPress theme and mobile viewport.

## Navigation behavior

1. The iframe sends a `ctsg-navigation-v1` / `ready` message.
2. The parent replies with its current hash route. The parent route wins on first load and reload, including `https://ctsg.tech.cornell.edu/#/clubs`.
3. A normal internal click sends `navigate` to the parent. The parent adds one hash history entry and replies with the new route.
4. The iframe renders that route and replaces its own URL without adding another history entry.
5. Parent `popstate` and `hashchange` events restore the child route. Back/Forward should therefore require one step per navigation.

Without a bridge, the child manages its own hash history. Standalone mode works the same way. Modified clicks and “Open this page standalone” open hosted-site URLs; they do not preserve the Cornell wrapper. Unknown but valid routes show “Page not found.” Invalid hash formats fall back to Home. This prototype supports slash-separated lowercase letters, numbers, and hyphens; route queries and in-page anchors are not implemented.

Both sides validate the message channel, type, origin, source window, and route. The bridge derives the expected child origin from the iframe’s `src`. The child’s `allowedParents` list in `public/app.js` includes the Cornell origin and the two local parent origins; update it for an intentional staging parent and remove local entries for production if desired. Messages never use a wildcard destination.

Hash routes require no WordPress or static-host rewrite rules: fragments are not sent to the server. Existing WordPress paths such as `/studentevents/` are not redirected by this prototype and need a separate migration decision.

## Manual acceptance checks

1. Open the synchronized demo. Confirm the mode says “parent URL sync connected.”
2. Click Clubs → Example Club → Members. Both the browser address and iframe diagnostics should show the same route.
3. Press Back twice and Forward twice. Each action should move exactly one page, without duplicate steps.
4. Reload while on a nested route. Open the same parent URL in a new tab. Both should render the matching child page.
5. Edit the parent hash to `#/by-laws`. The child should update. Try `#/missing-page` and confirm a not-found page with working navigation.
6. Click the current route again; it should not add a history entry.
7. Repeat navigation and reload in standalone mode.
8. Open the iframe-only demo at `#/clubs`: the child should start at Home and report no bridge. Clicking its links should work while the parent URL stays unchanged.
9. Repeat on the published WordPress page to verify script retention, framing headers, fullscreen positioning, and mobile behavior.

## Files

- `public/index.html`, `public/app.js`: homepage/member templates and child navigation.
- `public/styles/`: shared patterns and page-scoped styles.
- `public/wordpress-bridge.js`: parent-side URL/history bridge.
- `public/demo/`: local synchronized and iframe-only examples.
- `scripts/build.mjs`: image conversion, reference updates, and published-image validation.
- `scripts/dev.mjs`: local server for the built site on ports 8080 and 8081; not a production server.
- `.github/workflows/pages.yml`: validate changes and publish only a passing build once Pages is configured to use Actions.
- `tests/images.test.mjs`: conversion, sizing, reference, and validation tests.
- `tests/bridge.test.mjs`: parent protocol tests for deep links, history entries, and rejecting invalid messages; these do not replace browser testing.

The diagnostic snippet is prepared locally; it has not been applied to WordPress by this task.

## Verification status

The automated parent-bridge tests and JavaScript syntax checks pass. Local browser checks confirmed standalone link navigation and Back/Forward, cross-origin parent deep links, reload persistence, parent hash changes and Back/Forward synchronization, and iframe-only startup with no bridge. The browser automation tool could read the cross-origin iframe but could not click within it, so the embedded-click sequence in the acceptance checklist remains a manual check. Production WordPress bridge behavior has not been tested.
