# Student calendar

## Storage and updates

The website reads `public/data/calendar.json`; GitHub Actions imports sources daily at 00:43 UTC and on manual syncs. Signed calendar notifications refresh the three Notion event tables without rereading unrelated Cornell feeds. Builds and ordinary previews require no source credentials. See [repository sync](repository-sync.md) and [Notion notifications](notion-webhook.md).

`data-sync/calendar.json` stores per-source records, permanent history, and Notion query cursors. Ended events remain in JSON/ICS after disappearing upstream. Keep this file across academic years. Explicit Notion edits and received deletion notifications can correct or withdraw archived records. If a historical deletion notification is missed, the daily query may not discover it; the archived event remains.

An import failure leaves the saved files and deployed calendar intact. Unchanged snapshots keep their timestamp and create no site build. Check the sync workflow to establish that a recent reconciliation succeeded; snapshot age alone is insufficient. A Notion HTTP 429 creates the shared next-UTC-day cooldown documented in [repository sync](repository-sync.md).

## Sources and publication rules

| Source | Included content |
| --- | --- |
| Student Affairs, Inclusion & Belonging, Career Management | Official Cornell Tech CampusGroups department feeds, including eligible cohosted and program-specific events. |
| [Cornell Tech events](https://tech.cornell.edu/events/) | Verified public listings for current students or public audiences. Prospective-only and private events are excluded. |
| Notion Club, Community, and CTSG Events | Records with `Approval status` exactly `Published`, a title, and a date; cancelled, archived, trashed, and unpublished records are excluded. |
| [Cornell Registrar](https://registrar.cornell.edu/calendars-exams/academic-calendar) | Fall/Spring instruction, holidays, breaks, study/exam windows, course deadlines, and graduate/professional/Cornell Tech enrollment openings. |
| [Cornell Tech academic calendar](https://studentaffairs.tech.cornell.edu/academics/academic-calendar/) | Maker Days and new-admit pre-enrollment; shared dates remain in the Registrar source. |

Calendar times use New York time. All-day records preserve exclusive end dates. Recurring ICS events and exceptions expand within a 90-day-back/400-day-ahead import window; permanent history is retained separately. Academic importers read the current year or semester heading from permanent source URLs. Individual course exams and program exceptions require checking with the program.

CampusGroups imports exclude cancellations, postponements, private audiences, and clearly prospective-only events. Audience labels describe eligibility; the registration page determines whether a student can attend. Clubs use the explicit Notion approval path. Public and student exports share stable department/UID identities. Matching recognized registration/event URLs and start times merge records across sources; titles alone do not merge events. Merged events remain available under every contributing source filter.

Cornell Tech's paginated listing omits years. Its importer verifies full dates from official Cornell or supported organizer metadata rather than guessing a year. An event with an unverifiable date is withheld with a warning; a broken listing stops that source import. Registrar and Tech HTML changes may require parser maintenance.

## Notion event editing

Edit the three databases under [Notion Events](https://app.notion.com/p/3eb0b1bd67918044910ccfc7b84c5785). The database selects the calendar category. The importer reads `Event Title`, `Date`, `Description`, `Registration Form Link`, and `Club Name` / `Organization Name`; CTSG is the default organizer for its table. Optional `Location` and `Event status` are supported. Images, internal Notion URLs, and other properties are excluded.

| Calendar | Data source | Environment override |
| --- | --- | --- |
| Clubs | `3e90b1bd-6791-8091-bca0-000bcfad61a1` | `NOTION_DATA_SOURCE_ID` |
| Community | `0f87b6db-eb03-4aad-a000-c01ac1429e2d` | `NOTION_COMMUNITY_DATA_SOURCE_ID` |
| CTSG | `d1c3e93b-0500-48ac-b0e1-8ae59a15ef6d` | `NOTION_CTSG_DATA_SOURCE_ID` |

The read-only **CTSG Calendar** connection has access to Events and its child databases. Its credential is the GitHub Actions secret `NOTION_TOKEN`. Replace credentials in Actions secrets and verify a successful sync; never commit tokens or paste them into documentation. See [webhook setup](notion-webhook.md) for signed notifications.

## Student subscriptions and coverage

Account-specific Student Affairs and Career Management export URLs are GitHub Actions secrets `CAMPUSGROUPS_STUDENT_AFFAIRS_URL` and `CAMPUSGROUPS_CAREER_MANAGEMENT_URL`. `CAMPUSGROUPS_INCLUSION_BELONGING_URL` is supported when available. These URLs depend on the issuing account and its group access; replace and verify them during officer handoff.

Student exports publish titles, times, categories, audience labels, and canonical registration links. Private descriptions and locations are replaced with the official event link; matching public records may supply public descriptions and locations. Personalized subscription URLs, contacts, and private notes never enter saved data.

Coverage is limited by upstream exports. On September 30, 2026, the October 1 Employer Roundtables preparation and October 2 Employer Roundtables were visible in CampusGroups but absent from the Career Management export. A working feed or matching count cannot prove every relevant event is present.

Each source keeps upcoming-event count comparisons over the same date horizon. A newly empty source or a drop of at least five events and half the previous count produces a warning. These checks detect large changes, not individual omissions. `npm run calendar:check` reads the published snapshot; `.github/workflows/calendar-health.yml` runs that check every six hours. Check the main sync workflow for import failures and recent successful reconciliation.

## Subscription compatibility and maintenance

Existing calendar subscriptions use [the ICS endpoint](https://ctsg-calendar.mh2682.workers.dev/api/calendar.ics). The matching [JSON endpoint](https://ctsg-calendar.mh2682.workers.dev/api/calendar) remains available. `calendar/static-worker.mjs` forwards both to the published files and caches responses for five minutes. Calendar apps choose their own refresh intervals. The Worker does not import sources or run a refresh cron.

`calendar/wrangler.jsonc` records the existing account, retained storage bindings, and `CALENDAR_SNAPSHOT_BASE_URL`. The old Durable Object export remains for migration compatibility; public requests do not invoke it. Retained KV/Durable Object resources must not be removed as part of ordinary source cleanup. If hosting moves, update that base URL and `public/calendar-config.js` while preserving the subscription domain where possible.

A separately authorized Worker update uses:

```sh
npx wrangler@4.143.1 deploy --config calendar/wrangler.jsonc
```

Website publication uses the validated GitHub Pages workflow. Before officer handoff, verify access to GitHub Actions secrets, the read-only Notion connection, the Cloudflare account/domain, and the CampusGroups accounts issuing subscriptions. Keep the endpoint under continuing CTSG control.

## Local checks

```sh
npm run check
npm test
npm run build
npm run images:check
```

`npm run calendar:sync` imports upstream data using environment credentials and updates saved files. `npm run data:sync` reconciles Calendar, People, and Blog together. Normal `npm run dev` previews the published calendar with the local snapshot as fallback; its `/api/calendar` and `/api/calendar.ics` endpoints expose the same data.

For calendar importer development, `CALENDAR_LOCAL_SOURCES=1 npm run dev` enables local upstream imports at those API routes. The website continues to read its configured static snapshot. Inspect that local API with `npm run calendar:check -- --url http://localhost:8081/api/calendar`.
