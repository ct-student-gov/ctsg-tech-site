# Clubs

The banner shows chess and board-game tables at Cornell Tech's 2025 Club Fair. The original `DSC_0534.JPG` is saved locally under `public/images/clubs/2025/` and is used only on Clubs. Photo: Nghi T., from the [Club Fair photo album](https://drive.google.com/drive/u/0/folders/1FbQBVJKetYWDMIRWKMZgBwawKGK6TZ1t). It follows the shared page banner dimensions and fade.

The club directory at `#/clubs` uses [the Clubs database](https://app.notion.com/p/3ea0b1bd679180de868bc396ff9360c7). Check **Publish** on the records that should appear; unchecked, archived and trashed records are excluded. A published club needs a Name.

The page displays Name, Description, President, Vice President, Treasurer, Faculty/Staff Advisor, “How will students join your club/receive club communications?” and “If your group already has a group chat or Slack channel, please provide the link here:”. Complete HTTP(S) joining URLs become links. Other registration properties and page bodies are not imported. Clubs sort alphabetically. Each club occupies a horizontal row with its name, description and joining information, and officers. The layout uses the shared site typography, colors and dividing rules, and stacks on small screens. No logos are added.

`npm run clubs:sync` reads `NOTION_CLUBS_TOKEN` from the environment and writes `public/data/clubs.json` and `data-sync/clubs.json`. The database's single data source is resolved through the Notion API; `NOTION_CLUBS_DATA_SOURCE_ID` can override it locally. The importer expects Name as title, Publish as checkbox, the display fields as text, and the group link field as text or URL. Schema changes, incomplete responses and invalid published names fail the sync, preserving saved content. Unchanged content produces no file changes. Withdrawals take effect after a successful complete sync.

## Connection and activation

Activated October 7, 2026: the read-only **CTSG Clubs** connection is scoped to the Clubs database, and `NOTION_CLUBS_TOKEN` is stored in repository Actions secrets. Publish is enabled for 47 clubs; Luxury and Retail Club (Merged with Fashion Club) remains unchecked. The initial import saved 47 clubs, and a second import made no changes. All 48 records are marked 2026–27.

For setup in another environment:

1. Select the clubs to publish by checking Publish. Leave merged or withdrawn clubs unchecked.
2. Create a read-only Notion connection scoped to this Clubs database and save its token as the repository Actions secret `NOTION_CLUBS_TOKEN`. Do not paste the token into chat or commit it.
3. Import and review the first snapshot, then validate with `npm run clubs:check`, `npm run build`, and `npm run images:check` before publication.

When configured, Clubs joins the existing daily/manual repository sync and shared rate-limit cooldown. The workflow forces its first import before publication when the token is configured. An established Clubs sync fails if its token disappears. Instant Notion webhook setup is not part of this change. Browser previews can use the published snapshot with local fallback, as they do for other content.

API references: [retrieve database](https://developers.notion.com/reference/retrieve-a-database), [query data source](https://developers.notion.com/reference/query-a-data-source).
