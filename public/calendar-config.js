// GitHub Actions maintains the checked-in snapshot. Reading the calendar never
// calls Notion or consumes Cloudflare storage operations.
export const calendarEndpoint = new URL("./data/calendar.json", import.meta.url).href;
export const publishedCalendarSnapshot = "https://ct-student-gov.github.io/ctsg-tech-site/public/data/calendar.json";

// Preserve existing subscriptions. The compatibility Worker serves the repo's
// published ICS; it no longer imports sources or writes a database.
export const publishedCalendarFeed = "https://ctsg-calendar.mh2682.workers.dev/api/calendar.ics";
