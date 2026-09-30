# People from Notion

The published snapshot contains all 91 published profiles imported through the Notion API on September 30, including Swar and the generic representative roles. The two unpublished TBD cards are excluded. All existing biographies matched the source; Swar’s supplied biography and photo are included. The read-only **CTSG People** connection is configured for Team Directory, and its token is saved as the GitHub Actions secret `NOTION_PEOPLE_TOKEN`. GitHub Pages publication and the daily sync workflow are active. See [repository sync](repository-sync.md) for deployment and notification status.

The initial local export used the existing Notion connector. The first API import subsequently fetched all 91 biographies and photos and populated verified photo identities. An immediate unchanged repeat used two metadata requests, fetched no biographies or photos, and changed no files.

The [Team Directory](https://app.notion.com/p/398dc939e9f24b9b8a94f1a32c15d630) is the editing source (`140882c6-08ed-4e2a-9bcd-399ae6ba065b`). Only checked **Publish** records enter the site. Successful syncs remove unchecked, deleted or archived profiles. Separate records preserve different roles/bios across academic years.

Each published profile needs Name, Role, Section, Academic Year and one Photo. Program, Graduation Year and biography can be blank for historical members. Biographies consist of paragraphs below **Website Bio**, ending before the next level-one/two heading. Person, Email, Subcommittee, work-item databases and other internal page content are never published.

`public/data/people.js` remains the source consumed by the existing renderer. Its group banner, layout, expandable biographies and ordering remain intact. Photos are stored as real WebP files in `public/images/members/notion/<year>/` with content hashes in their names. Other supported raster uploads are converted and resized to at most 2048 pixels; this changes the website copy, not the Notion upload. Old photos remain in repository history.

`data-sync/people.json` stores published page versions, public bios and hashed photo identities. A daily metadata query detects changes without repeatedly fetching biographies or downloading pictures. Expiring Notion file URLs never enter saved data. Calendar and People notifications share a conservative rate-limit cooldown; unchanged runs create no commit/build. A failed sync leaves the last published roster visible until a successful later run applies changes.

The read-only **CTSG People** connection has access only to Team Directory, with read-content capability and no write/comment/user-information capabilities. Keep its token in the GitHub Actions secret `NOTION_PEOPLE_TOKEN`. Use the Cloudflare relay only for signed update notifications; public profile data and photos live in the repository.

Run `npm run people:check` for focused validation or `npm run data:sync` for the complete import with configured credentials. Builds and normal local previews require no Notion access.
