# Open work

This is the durable register for unresolved findings from repository maintenance. Existing feature requests remain tracked in [GitHub issues](https://github.com/ct-student-gov/ctsg-tech-site/issues); this register does not close or replace them. Keep entries and their history when acceptance is met.

## CI-001 — Calendar coverage workflow fails on omitted Cornell Tech events

**State: failed acceptance; cause diagnosed, remediation open.** Recorded November 3, 2026.

Evidence: [failed coverage run 41653698489](https://github.com/ct-student-gov/ctsg-tech-site/actions/runs/41653698489), its `npm run calendar:check` output, and the published `public/data/calendar.json` snapshot updated November 3 at 07:14:39 UTC. It reports four `unverified-events` omissions. The [site build/deployment 41595002776](https://github.com/ct-student-gov/ctsg-tech-site/actions/runs/41595002776) passed. The coverage command exits 1 whenever `calendarHealth` reports an issue; the workflow is successfully detecting incomplete source coverage, not failing to install or build.

Acceptance: resolve each omission below using verified source dates or evidence that the event is outside the existing publication rules; preserve alerts for genuinely unverified events. Then refresh the published calendar and record a passing coverage workflow. A successful build, a retry, disabling the check, or merely suppressing its warning does not satisfy this item.

| ID | Omission / evidence | State and next action |
| --- | --- | --- |
| CI-001a | [FDA & Healthcare Regulatory Considerations for Startups](https://tech.cornell.edu/events/fda-healthcare-regulatory-considerations-for-startups/) links to `cornell.zoom.us`. The importer permits Cornell domains and Gomry, but not Zoom. The Cornell event page's displayed date omits the year. | **Missing from this source.** Find authoritative full-date metadata; implement and test supported parsing if available. Do not infer the event year from publication or today's date. |
| CI-001b | [Weill Cornell Medicine Dean's Symposium](https://tech.cornell.edu/events/weill-cornell-medicine-deans-symposium-on-innovation-and-entrepreneurship/) links to Eventbrite, outside the supported organizer domains. The Cornell displayed date omits the year. | **Missing from this source.** Verify organizer metadata and implement bounded support or locate an existing supported authoritative source. |
| CI-001c | [Cornell Tech Open House](https://tech.cornell.edu/events/cornell-tech-open-house/) links to a Cornell registration page, but no supported full date was parsed. Its description concerns master's-program admissions. | **Missing; eligibility unverified.** Establish whether existing prospective-only exclusion rules apply before adding date parsing. Do not classify it solely to clear the warning. |
| CI-001d | [Computer Architecture colloquium](https://tech.cornell.edu/events/the-evolution-of-computer-architecture-to-service-machine-learning-and-scientific-computing/) shows Wednesday, November 18, 10 AM, without a year or organizer link. Its JSON-LD has a WebPage publication timestamp, not an Event date. | **Missing from this source.** Obtain an authoritative full event date/feed or upstream metadata correction; then test the importer and verify publication. |

History: November 3 — inspected failed workflow logs, refreshed the local checkout to `4bb1a2e`, inspected the live snapshot and the four current Cornell detail pages. No importer policy, event data, or workflow failure condition changed. No acceptance closure claimed.

## COV-002 — Previously observed Career Management export omissions

**State: missing in the observed export; current resolution unverified.** [Calendar documentation](calendar.md#student-subscriptions-and-coverage) records that the October 1 Employer Roundtables preparation and October 2 Employer Roundtables were visible in CampusGroups but absent from its export on September 30, 2026. This predates CI-001 and is not established as the cause of the current failed run.

Next action: reconcile those events against authoritative event records and the saved calendar history. Acceptance requires evidence that the relevant events are represented correctly, or an explicit user waiver; a passing count check alone is insufficient.
