import { publishedCalendarSnapshot } from "../public/calendar-config.js";
import { calendarHealth } from "../calendar/coverage.mjs";

const args = process.argv.slice(2);
try {
  if (args.includes("--help")) {
    console.log("Usage: npm run calendar:check -- [--url https://host/api/calendar]");
    console.log("Checks source freshness and suspicious count drops. Counts cannot detect every omitted event.");
  } else {
    if (args.length && (args.length !== 2 || args[0] !== "--url")) throw new Error("Use --url followed by a calendar JSON endpoint, or --help.");
    const endpoint = new URL(args[1] || publishedCalendarSnapshot);
    if (!["https:", "http:"].includes(endpoint.protocol)) throw new Error("Calendar URL must use HTTP or HTTPS.");
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(30000), headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Calendar endpoint returned HTTP ${response.status}.`);
    const health = calendarHealth(await response.json());
    console.log(`${health.eventCount} calendar events after deduplication; ${health.sources.length} sources.`);
    for (const source of health.sources) {
      const counts = source.coverage ? `${source.coverage.eventCount} imported, ${source.coverage.upcomingCount} upcoming` : "counts unavailable";
      if (source.state === "unconfigured") console.log(`INFO ${source.name}: optional integration is not configured.`);
      else console.log(`${source.issues.length ? "WARN" : "OK"} ${source.name}: ${source.state}; ${counts}.`);
      for (const issue of source.issues) console.log(`  ${issue.message}`);
    }
    console.log("Count checks cannot prove completeness or detect individual events missing from an export.");
    if (!health.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(`Calendar check failed: ${error.message}`);
  process.exitCode = 1;
}
