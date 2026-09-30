# Student calendar

## Repository storage and updates (current local implementation)

The calendar now has a repository-backed import path: permanent history and per-source caches live in `data-sync/calendar.json`, with public JSON/ICS in `public/data/`. GitHub Actions is configured to refresh sources daily and handle Notion change notifications. The website reads static files; the existing Cloudflare subscription URL becomes a compatibility proxy. The first repository import retained all 87 events from the live service with no coverage warnings. Production cutover remains pending activation verification.

See [repository sync](repository-sync.md) for behavior, failure handling, tests and the required activation order. Ended events survive upstream removal. Ordinary refreshes skip known historical detail requests; explicit Notion edits can correct archived records. Unchanged snapshots do not create daily commits or builds.

The legacy Durable Object importer remains available in the code during migration and its existing storage is not deleted. The sections below record the previous production architecture and coverage research; their 15-minute/six-hour refresh, KV storage, outage TTL and public-only fallback descriptions are superseded once the repository cutover is activated.

## Broader coverage: implementation and activation

The September 30 coverage expansion is deployed to the existing Cloudflare `ctsg-calendar` service (version `679e71fa-1554-46f8-a030-5fe7c816647d`). It adds Cornell Tech's main event listing, retains events relevant to individual student programs, preserves audience labels in calendar subscriptions, merges matching official registration links, and keeps verified public descriptions when a student subscription supplies an update. Source counts and suspicious-drop diagnostics run inside the existing Cloudflare refresh schedule. The accompanying website controls/audience labels and separate GitHub health-check workflow remain local and unpublished. Existing Notion approval rules are preserved; no organizer feeds or institutional credentials have been assumed.

For future service updates and the remaining website activation:

1. Run `npm run check`, `npm test`, `npm run build`, and `npm run images:check`.
2. Deploy the calendar service from this directory with `npx wrangler@4.143.1 deploy --config calendar/wrangler.jsonc`. This is a separate deployment from the website. The existing student subscription secrets stay on that service; do not copy them into source files.
3. Run `npm run calendar:check`. Confirm the Cornell Tech source and connected department sources are current, include coverage counts, and report no warnings. The first successful import establishes the comparison baseline. Existing source caches may take up to 15 minutes after deployment to expire and acquire the new diagnostics.
4. Publish the validated website through the existing repository workflow after reviewing/committing the changes. The new Cornell Tech filter and audience labels require the website update. Publishing these repository changes also enables `.github/workflows/calendar-health.yml` on the default branch; it checks the hosted service every six hours and supports a manual run. Deploy the service first so that this check does not fail against the old API.
5. In GitHub, enable the desired Actions failure notifications for this repository. A failed workflow is the alert mechanism; this code does not configure notification preferences or send messages. GitHub may delay scheduled jobs. Cloudflare's existing refresh schedule remains responsible for updates.

The health command also accepts another JSON endpoint, for example `npm run calendar:check -- --url http://localhost:8081/api/calendar` with `CALENDAR_LOCAL_SOURCES=1 npm run dev`. Normal site previews still use the hosted calendar, as documented below.

### One-time actions for the remaining coverage gaps

1. **Ask Cornell Tech's CampusGroups administrator or Career Management for a durable, read-only institutional event export/API.** A concrete request is: “Please provide a supported export of all published events available to current Cornell Tech students, including program-specific and cohosted events. We need pagination, stable event IDs, start/end with timezone, audience/eligibility, publication and cancellation status, update timestamps, organizer, and the official registration URL. Access should survive student-officer turnover. The October 1 Employer Roundtables preparation and October 2 Employer Roundtables were visible in the student listing but absent from the Career Management subscription on September 30; please include those as completeness checks.” API availability and school access are not yet verified. No request has been sent.
2. **Choose the trusted organizer policy before automatic club publication.** Identify the recognized club/department calendars allowed to publish automatically, then obtain each organizer's maintained ICS/API URL. This would replace per-event calendar review only for those explicitly approved sources. No blanket club approval or general-purpose trusted-feed configuration has been added in this change. Do not use private membership exports as public detail feeds.
3. **If retaining event-by-event approval, connect the existing Notion database using the setup below.** Approving a record there will update the calendar automatically, but this still entails approval work. The current submission page remains a mock; it is not a functioning intake service.
4. **Verify any new institutional export against the source listing before connecting it.** Compare event IDs over the same time range, exercise pagination, check one rescheduled/cancelled event, and confirm the two known missing Roundtables events. A healthy connection or matching total alone does not prove completeness.

Routine event entry is unnecessary for connected sources. Source markup changes, credentials losing access, and events never published to any accessible source can still require intervention. Program and audience labels describe eligibility; inclusion does not imply every student can register.

Local expansion verification on September 30, 2026: all 66 tests and syntax checks passed. A live public-source sync returned 60 events with all six public sources current and no coverage warnings. Cornell Tech's listing contained 65 entries; 63 admissions-only entries were excluded and two verified events imported. The public snapshot also regained two program-specific summer events. Private student feeds remain on the deployed Worker and were not fetched or copied locally. These results do not resolve the known CampusGroups export omissions.

Production expansion verification on September 30, 2026 at 1:19 p.m. New York time: the existing Cloudflare service returned 87 deduplicated entries in both JSON and ICS (58 upcoming/ongoing, including academic dates). All eight connected sources reported current with coverage diagnostics and no warnings; Notion remains unconfigured. The student imports retained 13 of 14 Student Affairs entries and all 23 Career Management entries under the expanded audience rules. The October 1–2 Employer Roundtables remain absent. The original Worker URL, storage bindings, and six-hour schedule were preserved. The main Events page still requires its separate website publication to show the new Cornell Tech filter, audience labels, and merged-source filtering; the hosted subscription feed already includes the expansion.

The Events page combines these sources in the site's own week/month/list calendar:

| Source | Publication rule |
| --- | --- |
| [Cornell Tech Student Affairs](https://cornelltech.campusgroups.com/ical/cornelltech/ical_club_37005.ics) | Official department's public CampusGroups ICS feed; audience restrictions below apply. This is not a guarantee of every Cornell Tech event. |
| [Inclusion & Belonging](https://cornelltech.campusgroups.com/ical/cornelltech/ical_club_73165.ics) | Official DEI/Inclusion & Belonging department's public ICS feed; audience restrictions below apply. |
| [Career Management](https://cornelltech.campusgroups.com/ical/cornelltech/ical_club_20032.ics) | Official department's public ICS feed; checked even when empty so future eligible postings appear automatically. |
| [Cornell Tech events](https://tech.cornell.edu/events/) | Paginated public event listings with student/public audiences; dates must be verified from official event metadata. Prospective-only and private events are excluded. |
| [CTSG Events database](https://www.notion.so/3e90b1bd6791809ab7c9de0490a60c95) | Only records with `Approval status` exactly `Published`; blank/pending/rejected/archived/cancelled records are excluded. |
| [Cornell Registrar](https://registrar.cornell.edu/calendars-exams/academic-calendar) | Holidays, breaks, full Fall/Spring instruction dates, study periods, full/7-week exam windows, course add/drop/credit/grading-basis deadlines, and enrollment opening windows explicitly labeled Graduate/Professional/Cornell Tech. Undergraduate-only openings, administrative grade deadlines, and unrelated summer/winter course deadlines are excluded. |
| [Cornell Tech academic calendar](https://studentaffairs.tech.cornell.edu/academics/academic-calendar/) | Maker Days and new-admit pre-enrollment with its published opening/closing times; shared academic dates remain in the Registrar import to avoid duplicates. |

The main Cornell Tech importer follows the public site's paginated event-listing API. Its pages omit years, so it requires full Event JSON-LD dates or a full Cornell AAP event-header date from the official event or its linked organizer, and checks that they agree with the listing's day and time. Linked date sources are restricted to Cornell domains and Gomry. An individual event with unverifiable dates or an unsupported organizer is withheld with a coverage warning while other verified events continue updating. A broken/incomplete listing fails the source refresh and preserves its last valid cache. New organizers may require another date adapter; this importer does not infer the year from today's date.

The service reads the registrar's HTML because a reliable official academic ICS endpoint has not been verified. This adapter can need repair if the registrar changes its markup. The `events.cornell.edu/search/events.ics?search=key%2BCornell%2Bdates` candidate returned unrelated events and a May 10, 2027 instruction-end date that conflicted with the registrar's May 11 date when checked on September 28, 2026; it is not used.

Academic dates use the permanent Registrar and Tech URLs above, not year-specific URLs. Importers read the academic year or semester heading each time. Published enrollment opening and deadline times are preserved in New York time; full-day breaks/exam ranges remain all-day. Fall/Spring seven-week instruction start/end dates are included alongside full-semester dates. Individual course exams and program-specific exceptions still need to be checked with the program. There are no manually entered production event dates. Registrar subscription IDs include the academic year and event title rather than the date. Tech supplement IDs use the semester, event type and occurrence order, so a date correction retains its ID when occurrence order is unchanged.

The deployed Cloudflare Worker has a recurring trigger every six hours, with no end date. It refreshes persistent data even without website visitors or an open laptop. Website/feed requests also refresh data once it is 15 minutes old. Failed fetches or invalid calendar markup retain the last valid public-source cache and mark the scheduled invocation as failed. Hosting must remain active, and a source layout change may require a parser update.

Automatic CampusGroups imports are limited to Student Affairs, Inclusion & Belonging, and Career Management, including cohosted entries that include the expected department. Club-hosted events stay on the separate explicit-approval path, even when open to everyone. Cornell Tech's main public event listing is a separate automatic source.

### Student subscription connection and coverage

At the user's request, the service also reads the account-specific **Student Affairs** and **Career Management** group subscriptions. Their URLs are stored only in Worker secrets `CAMPUSGROUPS_STUDENT_AFFAIRS_URL` and `CAMPUSGROUPS_CAREER_MANAGEMENT_URL`. The same adapter supports `CAMPUSGROUPS_INCLUSION_BELONGING_URL`, but it is not configured: that department's subscription dialog returned its existing public feed. Never paste personalized URLs into source control, a public calendar, logs, or documentation. To replace a connection, use CampusGroups' department subscription dialog and put its URL in the corresponding Worker secret with Wrangler's `secret put` command. No browser cookies or saved browser login are used by the running service.

The student adapter accepts only Cornell Tech CampusGroups group exports, verifies the department acronym on each event, applies audience rules, and publishes only titles, times, categories, audience tags, and canonical registration links. Descriptions and locations are replaced with a link to the official event page so private joining instructions are not redistributed. A matching public event can provide its public description/location during merging. The adapter does not publish account subscription URLs, contacts, or private notes. Student and public exports share stable department/UID identities and are deduplicated. Student subscription records have separate caches; outages retain them for at most one hour, and removing a secret immediately disables that source. The static outage snapshot remains public-source-only.

The September 30, 2026 sweep reviewed the subscription catalog's 1,150 groups (1,143 company entries and seven other groups), the official department exports, the school-wide public export, and the signed-in upcoming listings. Results:

| Source | Finding |
| --- | --- |
| Career Management | Public feed: zero. Student group subscription: 23 entries, of which 15 meet the broad-audience rule, including eight upcoming entries. Includes Interstride training (Oct 7), Climate Advocacy Symposium (Oct 16), XRP Ledger Hackathon (Oct 24), Tesla resume workshop (Oct 27), and November/December workshops. |
| Student Affairs | Public feed: 12. Student subscription: 14; adds the Dec 7 Hot Chocolate event. Program-specific summer events and a postponed orientation event are excluded. |
| Inclusion & Belonging | Two entries; the signed-in subscription link returns the same public source already connected. |
| Risk Management & Insurance | Empty export; no additional event found to import. |
| Home Page and test group | Empty public exports; not student-service event sources. |
| Student Organized Events & Activities @CT | Export returns HTTP 404; remains outside automatic imports under the club-review rule. |
| Company groups | Catalog entries were reviewed as a source category, not 1,143 individual event feeds. Broad-audience employer events distributed by Career Management are imported through that official department. Company calendars are not independently allowlisted. |

**Known upstream gap:** the signed-in events page reported 54 upcoming events, including the Oct 1 Employer Roundtables preparation session and Oct 2 Employer Roundtables, both tagged All Master's Students. Neither appears in the Career Management group subscription. A direct ICS download from the signed-in browser returned the same 23 entries as the server fetch, so using browser cookies would not resolve that export gap. The starred-groups account feed was empty, and the school-wide public feed contained only 11 entries. The connection therefore improves coverage but does not establish complete student-event coverage. CampusGroups/Career Management needs to make the omitted events available in a durable export or authorized API. No one-off production events were manually entered, and no staff message was sent. The careers resources website is not an event-calendar source.

The expanded department filter retains individual-program, Technical Programs, Design Tech, Jacobs, internship/new-grad, research seminar, and dissertation-defense events. Career events no longer require an explicit broad-audience tag. It excludes cancellations/postponements, explicit private audiences, and clearly prospective-only activities. Mixed prospective/current-student/public audience tags remain eligible. Audience tags are displayed in event details and ICS descriptions. A degree in a speaker biography or an art tour through staff-only spaces does not by itself restrict attendance. Cached events are filtered too. Missing or unusual audience metadata cannot establish eligibility; the official registration page remains authoritative. The earlier sweep's counts below/above reflect the former broad-audience policy, not a new live verification of the expanded rules.

These subscriptions depend on the account that issued them. There is no configured end date, but revocation, account deactivation, changed group membership, or upstream export changes can break them. Replace and verify the subscriptions during officer handoff; do not promise perpetual account access or complete export coverage.

## Current state

The recurring Worker was deployed on September 30, 2026 to the user's selected personal Cloudflare account (`bc913813b1125232b51bb639e7cd2dea`) on **Workers Free ($0)**. Its service is [calendar JSON](https://ctsg-calendar.mh2682.workers.dev/api/calendar), and its permanent subscription is [calendar ICS](https://ctsg-calendar.mh2682.workers.dev/api/calendar.ics). Cloudflare confirms the `17 */6 * * *` schedule (00:17, 06:17, 12:17, and 18:17 UTC) and the persistent `CALENDAR_CACHE` binding. Workers Logs are enabled for refresh failures.

The edge Worker forwards requests and scheduled refreshes to a single SQLite-backed `CalendarProcessor` Durable Object. Live source parsing exceeded the ordinary free Worker's 10-ms CPU allowance, so it runs inside the Durable Object's [30-second CPU allowance](https://developers.cloudflare.com/durable-objects/platform/limits/) instead. The object retains the existing KV cache, serializes simultaneous requests to avoid duplicate refreshes, and exposes its force-refresh route only through the internal binding. The website and subscription URLs are unchanged.

**Website builds point to this service, and the GitHub Pages workflow publishes only validated build output.** All website previews, including plain static servers such as port 8090, fetch the hosted calendar directly using `public/calendar-config.js`. They therefore include the same connected student subscriptions without copying credentials locally or requiring a local API. `npm run dev` also exposes `/api/calendar` for direct API checks; it forwards to the hosted calendar by default. For importer development, `CALENDAR_LOCAL_SOURCES=1 npm run dev` makes that API endpoint run the local importer with credentials from the process environment; the website continues to use the configured hosted endpoint. Calendar subscription links continue to use the public endpoint because calendar providers cannot fetch localhost. Notion is connected through the separately configured read-only CTSG Calendar API connection. The connected Notion tool in a chat does not itself give the website a permanent API credential.

A static build uses the hosted endpoint in `public/calendar-config.js`, with `public/data/calendar.json` as its outage fallback. Snapshot freshness remains in the JSON metadata; the page omits the update-status blurb. `npm run calendar:sync` manually refreshes this fallback plus its downloadable ICS. It deliberately saves only public sources, so withdrawn Notion approvals cannot survive indefinitely in a static file. Builds do not refresh the snapshot or deploy the service.

## One-time Notion setup

A local, unconnected form mock is available at `public/event-submission.html`, linked from Events. It is based on the existing Notion form's title, club name, 100-word description, date/time, and image questions. It adds location, organizer wording for non-club events, submission type, an official link required for external opportunities, and reviewer-only contact details/notes; images become optional. Club, CTSG, student-organized, and external recommendations all lead to a pending-review preview. Nothing is sent or saved, and the mock has not changed the live Notion form or the service's category mapping.

The prepared importer reads the three databases on the [Events page](https://app.notion.com/p/3eb0b1bd67918044910ccfc7b84c5785): **Club Events**, **Community Events**, and **CTSG Events**. Each has its own calendar source and filter; the source database determines the category without an Event type property. All three require `Approval status` exactly `Published`. Pending, rejected, blank, archived, and cancelled events are excluded. On a successful refresh, withdrawn approvals disappear; a failed refresh retains published events for at most one hour. No Notion events are saved in the static fallback.

The importer uses `Event Title`, `Date`, `Description`, `Registration Form Link`, and `Club Name` / `Organization Name`. CTSG is the default organizer for its own table. Optional `Location` and `Event status` are supported. Image files, internal Notion URLs, and other fields are not published.

The three-source importer is deployed to the existing Cloudflare service (code deployment `dd21aca2-0281-4d19-997e-0ca2e4363123`; its subsequent secret update activated Notion). The **CTSG Calendar** API connection has read-content capability only, with no write, comment, user-information, or agent access. Its content scope is the Events page and descendants. The token is stored as Cloudflare's `NOTION_TOKEN` secret; the temporary transfer file was removed.

Verified September 30, 2026 at 2:41 p.m. New York time: Club, Community, and CTSG all report `current`, with zero coverage warnings. The Published CTSG record “Event” appears on October 1 as an all-day event in the hosted feed and the localhost:8090 homepage calendar. New changes use the existing 15-minute request refresh and six-hour background schedule. The Community filter is available locally; the website has not been separately published during activation.

To replace this connection later:

1. Create an internal Notion integration with read-content access and grant it access to the Events page and all three child databases.
2. Store its token directly in Cloudflare using the hidden prompt below, from the repository root. Do not paste it into chat or a source file:

   ```sh
   npx wrangler@4.143.1 secret put NOTION_TOKEN --config calendar/wrangler.jsonc
   ```

3. Verify all three sources report current after replacing the token. Only records with a Published status and a title/date should appear.

The database IDs are configured in `calendar/wrangler.jsonc` and its example:

| Calendar | Data source | Configuration key |
| --- | --- | --- |
| Clubs | `3e90b1bd-6791-8091-bca0-000bcfad61a1` | `NOTION_DATA_SOURCE_ID` |
| Community | `0f87b6db-eb03-4aad-a000-c01ac1429e2d` | `NOTION_COMMUNITY_DATA_SOURCE_ID` |
| CTSG | `d1c3e93b-0500-48ac-b0e1-8ae59a15ef6d` | `NOTION_CTSG_DATA_SOURCE_ID` |

## Hosting and officer handoff

`calendar/worker.mjs` is a Cloudflare Workers adapter. `calendar/service.mjs` also works with another server that provides Fetch APIs and persistent storage with async `get(key, "json")` / `put(key, JSONstring)` methods.

The deployed account and KV namespace are recorded in `calendar/wrangler.jsonc`; the file contains identifiers, not credentials. To redeploy the existing service, run `npx wrangler@4.143.1 deploy --config calendar/wrangler.jsonc` after the checks below. Authentication is local to the administrator's machine; the running Worker and cron do not depend on that machine or its login token.

Before annual handoff, an existing verified Super Administrator can use **Manage account → Members → Invite** to add the incoming officer's own Cloudflare login with **Super Administrator - All Privileges**. Have the successor accept and verify access to this Worker, its KV namespace, and these source files before the outgoing officer leaves. Keep the existing account and `mh2682.workers.dev` subdomain to preserve subscriptions. [Cloudflare member-management instructions](https://developers.cloudflare.com/fundamentals/manage-members/manage/). No other officers have been invited by this setup.

Keep the Workers plan on Free; the current [free allowances](https://developers.cloudflare.com/workers/platform/pricing/) are 100,000 Worker requests/day, 10 ms CPU/invocation, 100,000 KV reads/day, 1,000 KV writes/day, and 1 GB storage. These are provider limits, not a promise of unchanged pricing forever.

The processor also uses the [Durable Objects free allowance](https://developers.cloudflare.com/durable-objects/platform/pricing/): 100,000 requests and 13,000 GB-seconds per day. The SQLite class migration in both Wrangler configs is required for free-plan eligibility; do not replace it with the legacy KV-backed Durable Object class type. Calendar records themselves remain in the separate Workers KV namespace. No paid plan or payment information was added.

For a fresh account or replacement deployment:

1. Copy `calendar/wrangler.example.jsonc` to `calendar/wrangler.jsonc` and replace its placeholder KV namespace ID after creating a namespace bound as `CALENDAR_CACHE`.
2. Add the `NOTION_TOKEN` secret using Wrangler's secret command with `--config calendar/wrangler.jsonc`. Do not place it in the config file. Set the data-source variable if the database changes.
3. Deploy that config when ready; its six-hour recurring trigger is included. Verify the trigger is registered and `/api/calendar` reports the public sources `current`, with an `academicYear` read from the Registrar page. If Notion is configured, verify a known published test event appears while an unpublished one does not; withdraw approval and verify it disappears after refresh.
4. Set `calendarEndpoint` in `public/calendar-config.js` to the permanent HTTPS service URL ending in `/api/calendar`. Build and publish the website through its normal process. Use the service's `/api/calendar.ics` URL for calendar subscriptions.

A server-side recurring trigger refreshes source data every six hours; requests also refresh data after 15 minutes. Open website calendars refresh every 15 minutes. Calendar apps determine their own subscription refresh intervals. Successful refreshes replace each source's records, so edits, cancellations, and removed approvals propagate. Stable source IDs prevent ordinary time changes from making duplicate subscribed events. Public and student exports from the same department are deduplicated by event UID. Across sources, matching recognized event/registration URLs plus the same start time merge duplicates; titles alone do not establish identity, and distinct sessions stay separate. Merged events remain visible under each contributing source's filter.

Each successful source import stores coverage counts. Comparisons count both snapshots' still-upcoming events in the same date horizon, so events ending naturally do not create a drop. A newly empty source or a loss of at least five upcoming events and at least half the previous count creates a warning. Warnings remain for up to 24 hours unless counts recover. Removed events are not retained to hide a drop. Scheduled Worker refreshes fail visibly on source errors or coverage warnings; the separate GitHub workflow checks freshness, errors, and warnings. Optional unconfigured Notion is informational. Counts cannot detect every individually omitted event or prove an export complete.

The persistent cache keeps public-source events during outages, with stale status and the source error recorded in the JSON metadata. Notion and student-subscription caches are retained for at most one hour during an outage, then those events are withheld until their source recovers. A successful empty response clears the corresponding cache. The Tech academic fetch explicitly follows redirects and sends an identifying User-Agent and Accept header; this request configuration was verified from the deployed Worker after its default request returned HTTP 520. Keep the service, domain, credentials, and access instructions under CTSG ownership; verify the source status and academic-year coverage during annual officer handoff. This reduces routine entry work but cannot guarantee an external feed will exist forever.

## Checks

Run `npm run check`, `npm test`, and `npm run build`. `npm run calendar:sync` verifies live public-source parsing and refreshes the saved data; it exits unsuccessfully if any public source could not refresh. The calendar uses New York time, preserves all-day dates with exclusive end dates, and expands recurring ICS events and exceptions within its 90-day-back/400-day-ahead display window. That window does not imply each source publishes that far ahead.

Deployment verification on September 30, 2026: the production JSON and ICS endpoints returned 46 events (37 academic, 9 Student Affairs), both public sources reported `current`, and the Registrar year was `2026–2027`. Cloudflare measured a fresh import at 1 ms in the edge Worker and 23 ms in the Durable Object, both within their respective free-plan limits. Public `/refresh` requests were rejected. The native local scheduled handler completed successfully, and the production six-hour cron registration was verified through Cloudflare's API; its first scheduled production invocation has not yet been observed. All 32 tests, syntax checks, the website build, and built-image validation passed.

Expanded-source verification later on September 30, 2026: the deployed service returned 57 events (42 Registrar, 5 Tech academic, 8 Student Affairs, 2 Inclusion & Belonging; Career Management currently empty). All five public sources reported `current`. The school-wide public CampusGroups feed contained no additional eligible events. All 37 tests passed, including semester rollover, seven-week instruction boundaries, timed new-admit enrollment and cached audience filtering. Local browser checks confirmed October's Maker Day, the postcard event, academic filtering and the official source link. The six-hour Worker schedule and permanent subscription URL are unchanged.

Student-subscription verification on September 30, 2026: both configured student feeds report `current` from the deployed Worker; Career Management contributes 15 eligible entries, eight upcoming, and Student Affairs adds December 7 Hot Chocolate. Live October browser checks confirmed the Interstride, Climate Advocacy, XRP Ledger, and Tesla events plus a working canonical registration link. October 1–2 Roundtables remain absent upstream. All 42 tests, syntax checks, production build, and image validation pass. Hosted subscription requests follow bounded redirects only within the same HTTPS CampusGroups origin; failed requests reveal only the processing stage or HTTP status. Breaks and holidays use the separately requested blue color, while other academic dates keep their existing color.
