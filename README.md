# Cornell Tech Student Government website

This repository will contain the custom CTSG website, hosted outside Cornell’s restricted WordPress environment and embedded at **https://ctsg.tech.cornell.edu/** in a fullscreen iframe.

For now it is an intentionally unstyled, dependency-free HTML/JavaScript prototype for testing navigation, hash URLs, deep links, reloads, and browser history. It is not a content migration or finished redesign.

## Current site review

Reviewed the public site on September 23, 2026:

| Existing page | Observed content | Prototype route |
| --- | --- | --- |
| [CTSG homepage](https://ctsg.tech.cornell.edu/) | About/mission, executive board profiles, master’s program representatives; several roles marked TBD | `#/` and `#/members` |
| [Student Events](https://ctsg.tech.cornell.edu/studentevents/) | Club Fair heading and image gallery | `#/events` |
| [Past Members](https://ctsg.tech.cornell.edu/sample-page/past-members/) | ’26 executive board and cohort representative roster | `#/past-members` |
| [CTSG By-Laws](https://ctsg.tech.cornell.edu/sample-page/ctsg-by-laws/) | By-Laws v4.2, articles, revision history, and table-of-contents links to Google Docs | `#/by-laws` |

The current navigation has CTSG and Student Events at the top, with Past Members and By-Laws under CTSG. The homepage mixes the introduction and member directory into one long page. The prototype separates those sections for navigation testing. `#/clubs` and `#/clubs/example` are proposed/test pages, not a directory found on the reviewed site. No names, photos, or bylaws have been migrated into the prototype.

## Run locally

Requires Node.js 20 or newer. There are no dependencies to install or build step.

```sh
npm run dev
```

Open **http://localhost:8080/demo/**. The development server exposes two different origins:

- `http://localhost:8080` simulates the WordPress parent page.
- `http://localhost:8081` serves the custom site inside the iframe.

The demo includes a synchronized fullscreen embed, a nested deep link, an iframe-only embed, and a standalone link. The site uses browser-default HTML styling; the only CSS positions the demo/embed iframe over the viewport.

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

Deploy the contents of `public/` to a static HTTPS host. Replace `https://YOUR-HOST.example/` below with the actual deployed site URL, including a repository subpath if applicable. This placeholder URL is not a deployment. Demo files are for local testing and can be excluded from deployment.

Paste the iframe into the WordPress page’s allowed HTML block:

```html
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

- `public/index.html`, `public/app.js`: unstyled site and child navigation.
- `public/wordpress-bridge.js`: parent-side URL/history bridge.
- `public/demo/`: local synchronized and iframe-only examples.
- `scripts/dev.mjs`: dependency-free local server on ports 8080 and 8081; not a production server.
- `tests/bridge.test.mjs`: parent protocol tests for deep links, history entries, and rejecting invalid messages; these do not replace browser testing.

Nothing has been deployed or changed on the live WordPress site.

## Verification status

The five automated parent-bridge tests and JavaScript syntax checks pass. Local browser checks confirmed standalone link navigation and Back/Forward, cross-origin parent deep links, reload persistence, parent hash changes and Back/Forward synchronization, and iframe-only startup with no bridge. The browser automation tool could read the cross-origin iframe but could not click within it, so the embedded-click sequence in the acceptance checklist remains a manual check. Production WordPress behavior has not been tested.
