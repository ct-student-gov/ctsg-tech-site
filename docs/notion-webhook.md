# Notion change notifications

`sync-webhook/worker.mjs` is a small Cloudflare relay. It verifies a Notion notification and sends a `repository_dispatch` event named `notion-updated` to `ct-student-gov/ctsg-tech-site`. The GitHub sync workflow fetches the current published data, updates the files in Git, and builds changed content. The relay stores no profiles, photos, calendar data, archive, or Notion API credentials, and needs no KV or Durable Object binding.

The daily GitHub schedule runs independently of this relay. It reconciles missed content changes; notification payloads are hints, not a complete list of changes. Historical deletion recovery has the [archive limitation documented here](repository-sync.md). Notion events can be delayed, aggregated or out of order. See [Notion event delivery](https://developers.notion.com/reference/webhooks-events-delivery).

Both subscriptions were activated on September 30, 2026 at `https://ctsg-notion-sync.mh2682.workers.dev/notion/calendar` and `/notion/people`. The GitHub credential is restricted to `ct-student-gov/ctsg-tech-site`, with Contents read/write and required Metadata read access. It expires **September 30, 2027**; replace `GITHUB_DISPATCH_TOKEN` before then. Daily GitHub syncs do not depend on that token.

Live notification checks passed: [Calendar](https://github.com/ct-student-gov/ctsg-tech-site/actions/runs/36781176635) retained all 87 events and [People](https://github.com/ct-student-gov/ctsg-tech-site/actions/runs/36781210293) retained all 91 profiles with zero portrait downloads. Both skipped the site build because public content was unchanged. Temporary verification forwarding, callback secrets and the tunnel were removed; both relay routes reject unsigned requests.

## Routes and secrets

| Route | Cloudflare secret containing that subscription's verification token |
| --- | --- |
| `/notion/calendar` | `NOTION_CALENDAR_WEBHOOK_SECRET` |
| `/notion/people` | `NOTION_PEOPLE_WEBHOOK_SECRET` |
| `/notion/blog` (prepared; not activated) | `NOTION_BLOG_WEBHOOK_SECRET` |

Blog has an independent read-only connection and signature secret. Its prepared route sends `source: blog` so only Blog is refreshed. The daily workflow imports Blog independently of notifications. See [Blog setup](blog.md).

Also set `GITHUB_DISPATCH_TOKEN` to a fine-grained GitHub token restricted to this repository with **Contents: read and write**. GitHub requires that permission for [repository dispatch](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#create-a-repository-dispatch-event). Track its expiry and replace the Cloudflare secret before it expires. The relay itself only calls the fixed repository's dispatch endpoint.

These are Worker secrets, never Wrangler `vars`, committed files, chat messages, or application logs. The Worker does not log request bodies or upstream error bodies; observability is disabled in its configuration.

## Activation

The workflow must be on the repository's default branch before GitHub can dispatch it. Deploy the relay using `sync-webhook/wrangler.jsonc`, then configure one subscription in each read-only Notion connection. Deployment and subscription setup are separate from merely adding these files to Git.

Notion delivers a `verification_token` during setup. It may include a signature and extra metadata. The production relay deliberately rejects verification payloads. Capture the token privately at the **final webhook URL**: changing an unverified URL regenerated the token during live activation, invalidating the one already captured.

1. Start a temporary local HTTP receiver behind an HTTPS tunnel under your control. Use an unpredictable path, accept only the setup POST at that path, write only its `verification_token` into a local file with mode `0600` in a private directory, and return an empty success response. Do not use a public webhook inspection service or log the request body.
2. With explicit approval for the temporary setup, deploy a short-lived wrapper on the relay's final URLs. For verification requests only, it forwards just `{verification_token}` to the private receiver using temporary callback secrets. It must not log request bodies or expose captured tokens. All ordinary requests continue through the authenticated relay. Remove this wrapper and the temporary callback secrets immediately after verification.
3. In the connection's Webhooks tab, create an **unverified** subscription pointing to the final `/notion/calendar` or `/notion/people` route. Choose the page events listed below. Notion sends the token once; its verification dialog also has a resend action. Keep the URL unchanged throughout verification.
4. Import the newly captured file into the appropriate Worker secret using standard input, for example:

   ```sh
   npx wrangler secret put NOTION_CALENDAR_WEBHOOK_SECRET --config sync-webhook/wrangler.jsonc < /private/path/calendar-verification-token
   ```

5. Copy the captured token directly into Notion's verification form and verify. After verification, changing the URL requires a new subscription. See [Notion's webhook verification procedure](https://developers.notion.com/reference/webhooks).
6. Restore the normal relay, delete temporary callback secrets, stop the receiver/tunnel and remove local token files. Repeat for the other connection, using a separate token.
7. Use temporary unpublished records to verify both connections start successful GitHub sync runs, then remove those records. Confirm an unchanged reconciliation skips the site build. Publication filtering and withdrawal are also covered by importer tests.

Subscribe to `page.created`, `page.properties_updated`, `page.content_updated`, `page.moved`, `page.deleted`, and `page.undeleted`. Body edits are needed for People biographies. The relay also accepts `data_source.schema_updated`, `data_source.moved`, `data_source.deleted`, `data_source.undeleted`, `database.moved`, `database.deleted`, and `database.undeleted` if selected. Comments and lock/unlock activity are ignored. Avoid also subscribing to data-source content notifications: the page events already cover those changes.

## Delivery behavior

Each event is authenticated using HMAC-SHA256 over the original request bytes with `X-Notion-Signature`. The Calendar secret cannot authenticate People events. Requests are capped at 64 KiB. Only event IDs, types, timestamps, source labels and entity IDs are sent to GitHub; author information and other Notion payload fields are omitted.

A successful GitHub `204` becomes a relay `202`. Network failures and every other GitHub status become `502`, allowing Notion to retry. Notion retries failed deliveries up to eight times over roughly a day; after that, the daily workflow is the recovery path. The relay makes no immediate retry loop of its own.

Up to 512 recently accepted event IDs are remembered in each Worker isolate for 25 hours. Concurrent retries in that isolate share one GitHub call. This is best-effort duplicate suppression, not durable storage: a new isolate may dispatch the event again. The workflow must serialize writes and reconcile from its saved state so duplicate or coalesced triggers are safe. A successful dispatch acknowledges scheduling, not workflow completion; a later workflow failure is recovered by the next scheduled run.

Run `node --test tests/notion-webhook.test.mjs` for signature, request validation, duplicate delivery and upstream failure checks. A Wrangler dry run checks the Worker bundle without deploying it.
