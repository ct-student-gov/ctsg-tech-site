# Blog from Notion

The homepage’s Projects section is now labelled Blog. Its existing card layout, article dialogs, photo galleries, and Show more control are retained. The four existing posts and all eight photos are preserved in `public/data/blog.js`.

Sunset Sendoff 2026, Big Red Gala 2026, Cornelloween 2025, and Club Fair 2025 were backported into Notion with their original dates, article text, all eight photos, and Publish checked. The initial connector export saved verified page versions and local photo identities in `data-sync/blog.json`; the website snapshot also retains the original image descriptions, captions, and credits. Future API syncs preserve those photo labels for unchanged image bytes.

Edit posts in [Notion Blog](https://app.notion.com/p/3eb0b1bd6791803780fff4a1b6834210), data source `3eb0b1bd-6791-80dd-87c6-000bc89419fd`:

- **Name** is the post title.
- **Publish** must be checked to show the post. Unchecking it, deleting the post, or archiving it removes it on the next successful sync.
- **Date** is required and sorts posts newest first.
- **Images** accepts multiple photos, in gallery order. The first photo is the card’s header image; all photos appear in the article gallery. There is no importer limit on the number of photos. Images can also be empty for a text post.
- **Image Alt Text** holds one description per line, in the same order as Images. Each image needs a nonempty description. This Notion field controls the visible gallery description and accessibility alt text on both the header image and gallery; the saved website data is only a copy. Photo credits stay separate. Missing or mismatched descriptions retain the last published post with a warning.
- The page body is the article. Paragraphs, headings, flat lists, quotes, code, dividers, inline formatting, and web/email links are supported. Put photos in Images. Embedded child pages/databases are excluded; unsupported or nested text blocks produce a warning and retain the last published article.

The importer follows the People system: a read-only Notion connection, a repository snapshot, local images, page-version/body caching, hashed attachment identities, and signed change notifications. An unchanged run queries metadata without rereading articles or downloading photos. Incomplete new posts are skipped; incomplete edits retain the last published post. API, pagination, schema, and image-download failures preserve the previous snapshot. Blog shares the existing rate-limit cooldown.

`npm run blog:sync` uses `NOTION_BLOG_TOKEN`. `NOTION_BLOG_DATA_SOURCE_ID` can override the source for another deployment. `npm run blog:check` runs focused tests. Builds and previews use the snapshot without credentials. Synced photos live under `public/images/blog/notion/<year>/`; SVGs remain vectors and raster photos become WebP, at most 2048 pixels.

## Activation status

The Notion fields and four backported posts are saved. The read-only **CTSG Blog** connection is scoped only to Blog, and its token is saved as the repository Actions secret `NOTION_BLOG_TOKEN`. A live API import verified all four posts without warnings; a second import made two metadata requests, downloaded no photos, and changed no files. The website and importer are published through the GitHub Pages workflow; the existing People connection retains its Team Directory scope.

Blog joins the existing daily/manual sync. Before its first import, that workflow forces a full sync. Without Blog credentials and without Blog sync state, existing Calendar/People jobs continue as before; after the first import, missing Blog credentials fail a complete sync to preserve the published data.

The local preview reads the published Blog snapshot and serves new published photos when they are missing locally, just like People. Each document reload invalidates the metadata cache and bypasses the static host cache, so published changes appear immediately on reload. Background requests still share a five-minute cache. It falls back to the built local snapshot when the published site is unavailable. Run `npm run dev` and reload the homepage; no Notion credentials are needed. Published Blog data also uses a fresh module URL on each page load.

Blog change notifications were activated on September 30, 2026 at `/notion/blog` with their own `NOTION_BLOG_WEBHOOK_SECRET`. The verified subscription listens to page creation, property/body edits, moves, deletion, and restoration using API version `2025-09-03`. The deployed signed relay sends `source: blog` to refresh Blog only; daily/manual imports remain independent. [A real Notion-triggered sync](https://github.com/ct-student-gov/ctsg-tech-site/actions/runs/36790230971) published current title/body edits with all four posts retained and zero photo downloads. Its unchanged repeat skipped publication. Temporary verification forwarding, callback secrets, local tokens, and the tunnel were removed. See [webhook setup](notion-webhook.md).
