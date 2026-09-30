# Notion change notifications

`sync-webhook/worker.mjs` is a small Cloudflare relay. It verifies a Notion notification and sends a `repository_dispatch` event named `notion-updated` to `ct-student-gov/ctsg-tech-site`. The GitHub sync workflow fetches the current published data, updates the files in Git, and builds changed content. The relay stores no profiles, photos, calendar data, archive, or Notion API credentials, and needs no KV or Durable Object binding.

The daily GitHub schedule runs independently of this relay. It reconciles missed content changes; notification payloads are hints, not a complete list of changes. Historical deletion recovery has the [archive limitation documented here](repository-sync.md). Notion events can be delayed, aggregated or out of order. See [Notion event delivery](https://developers.notion.com/reference/webhooks-events-delivery).

## Routes and secrets

| Route | Cloudflare secret containing that subscription's verification token |
| --- | --- |
| `/notion/calendar` | `NOTION_CALENDAR_WEBHOOK_SECRET` |
| `/notion/people` | `NOTION_PEOPLE_WEBHOOK_SECRET` |

Also set `GITHUB_DISPATCH_TOKEN` to a fine-grained GitHub token restricted to this repository with **Contents: read and write**. GitHub requires that permission for [repository dispatch](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#create-a-repository-dispatch-event). Track its expiry and replace the Cloudflare secret before it expires. The relay itself only calls the fixed repository's dispatch endpoint.

These are Worker secrets, never Wrangler `vars`, committed files, chat messages, or application logs. The Worker does not log request bodies or upstream error bodies; observability is disabled in its configuration.

## Activation

The workflow must be on the repository's default branch before GitHub can dispatch it. Deploy the relay using `sync-webhook/wrangler.jsonc`, then configure one subscription in each read-only Notion connection. Deployment and subscription setup are separate from merely adding these files to Git.

Notion initially delivers an **unsigned** `verification_token`. The public relay deliberately rejects unsigned requests. Capture that first token privately during setup:

1. Start a temporary local HTTP receiver behind an HTTPS tunnel under your control. Use an unpredictable path, accept only the setup POST at that path, write only its `verification_token` into a local file with mode `0600` in a private directory, and return an empty success response. Do not use a public webhook inspection service or log the request body.
2. In the connection's Webhooks tab, create an **unverified** subscription pointing to that temporary receiver. Choose the page events listed below. Notion sends the token once; its verification dialog also has a resend action.
3. Import the captured file into the appropriate Worker secret using standard input, for example:

   ```sh
   npx wrangler secret put NOTION_CALENDAR_WEBHOOK_SECRET --config sync-webhook/wrangler.jsonc < /private/path/calendar-verification-token
   ```

4. While the subscription is still **unverified**, change its URL to the deployed Worker's `/notion/calendar` or `/notion/people` route. Copy the captured token directly into Notion's verification form and verify. A webhook URL can be edited before verification; after verification, changing it requires a new subscription. This setup sequence follows [Notion's webhook verification procedure](https://developers.notion.com/reference/webhooks).
5. Stop the temporary receiver/tunnel and remove its token file after the Worker secret and Notion subscription are configured. Repeat for the other connection, using a separate token.
6. Edit a published record in each database, confirm the corresponding GitHub sync run and updated file, then confirm that an unchanged daily run does not rebuild the site. Test unpublishing a record as well.

Subscribe to `page.created`, `page.properties_updated`, `page.content_updated`, `page.moved`, `page.deleted`, and `page.undeleted`. Body edits are needed for People biographies. The relay also accepts `data_source.schema_updated`, `data_source.moved`, `data_source.deleted`, `data_source.undeleted`, `database.moved`, `database.deleted`, and `database.undeleted` if selected. Comments and lock/unlock activity are ignored. Avoid also subscribing to data-source content notifications: the page events already cover those changes.

## Delivery behavior

Each event is authenticated using HMAC-SHA256 over the original request bytes with `X-Notion-Signature`. The Calendar secret cannot authenticate People events. Requests are capped at 64 KiB. Only event IDs, types, timestamps, source labels and entity IDs are sent to GitHub; author information and other Notion payload fields are omitted.

A successful GitHub `204` becomes a relay `202`. Network failures and every other GitHub status become `502`, allowing Notion to retry. Notion retries failed deliveries up to eight times over roughly a day; after that, the daily workflow is the recovery path. The relay makes no immediate retry loop of its own.

Up to 512 recently accepted event IDs are remembered in each Worker isolate for 25 hours. Concurrent retries in that isolate share one GitHub call. This is best-effort duplicate suppression, not durable storage: a new isolate may dispatch the event again. The workflow must serialize writes and reconcile from its saved state so duplicate or coalesced triggers are safe. A successful dispatch acknowledges scheduling, not workflow completion; a later workflow failure is recovered by the next scheduled run.

Run `node --test tests/notion-webhook.test.mjs` for signature, request validation, duplicate delivery and upstream failure checks. A Wrangler dry run checks the Worker bundle without deploying it.
