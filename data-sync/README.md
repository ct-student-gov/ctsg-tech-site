# Saved website data

GitHub Actions creates `calendar.json` and `people.json` here after the first successful sync. These files are committed alongside `public/data/` and downloaded WebP portraits. They are repository storage, not an Actions cache and not a Cloudflare database.

- `calendar.json`: per-source public live events, permanent archived events, and Notion query cursors/page versions. Keep this file when rolling into a new academic year.
- `people.json`: published page versions, public biographies, local photo paths, and attachment identity hashes. This avoids rereading unchanged bios or downloading unchanged photos.
- `blog.json`: published post versions, public article bodies, local image paths, and attachment hashes. The initial backport was verified by a live Blog API sync. See [Blog setup](../docs/blog.md).
- `backoff.json`: exists only after Notion returns HTTP 429. Both syncs wait until its UTC deadline, then retry on the next trigger. A successful run removes it.

These files may be public in GitHub. Never put connection tokens, subscription URLs, private Notion properties, or temporary image URLs here. Deleting cache state forces another import; deleting the calendar archive can lose events no longer available upstream. Repo history retains earlier published data and images even after removal from the current website.

See [repository sync](../docs/repository-sync.md) for setup and operation.
