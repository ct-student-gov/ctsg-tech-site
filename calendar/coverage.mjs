const DAY = 24 * 60 * 60 * 1000;
const VERSION = 1;

const upcoming = (events, from, through) => events.filter(event => Date.parse(event.end || event.start) >= from && Date.parse(event.start) < through).length;
const endOfWindow = (data, fallback) => Number.isFinite(Date.parse(data.window?.end)) ? Date.parse(data.window.end) : fallback;

// Counts can expose an incomplete refresh, but cannot establish that a source
// publishes every relevant event. Never retain removed events to fix a count.
export function sourceCoverage(source, data, previous, now = new Date()) {
  const stamp = +now;
  const events = data.events || [];
  const through = endOfWindow(data, stamp + 400 * DAY);
  const result = {
    version: VERSION,
    eventCount: events.length,
    upcomingCount: upcoming(events, stamp, through),
    previousUpcomingCount: null,
    comparedThrough: null,
    warnings: [],
  };
  const previousStamp = Date.parse(previous?.updatedAt);
  // A policy/parser change or a long period without refreshes starts a new
  // baseline. Recount both snapshots at today's time to avoid seasonal drops
  // when yesterday's events simply finished.
  const comparable = previous?.coverage?.version === VERSION
    && Array.isArray(previous.events)
    && (!previous.state || previous.state === "current")
    && previousStamp <= stamp && stamp - previousStamp <= 7 * DAY;
  if (!comparable) return result;

  const comparisonEnd = Math.min(through, endOfWindow(previous, previousStamp + 400 * DAY));
  if (comparisonEnd <= stamp) return result;
  const currentCount = upcoming(events, stamp, comparisonEnd);
  const previousCount = upcoming(previous.events, stamp, comparisonEnd);
  result.previousUpcomingCount = previousCount;
  result.comparedThrough = new Date(comparisonEnd).toISOString();

  // Keep a suspicious result visible for a day instead of clearing it on the
  // next successful (but still incomplete) refresh. Recovery clears it early.
  result.warnings = (previous.coverage.warnings || []).filter(warning =>
    ["sudden-empty", "large-drop"].includes(warning.code)
    && Date.parse(warning.expiresAt) > stamp
    && Number.isFinite(warning.threshold)
    && currentCount <= warning.threshold
  ).map(warning => ({ ...warning }));

  let code, threshold, message;
  if (previousCount > 0 && currentCount === 0) {
    code = "sudden-empty";
    threshold = 0;
    message = `Upcoming events fell from ${previousCount} to zero in the same date range; verify the source export.`;
  } else if (previousCount >= 5 && previousCount - currentCount >= 5 && currentCount <= previousCount / 2) {
    code = "large-drop";
    threshold = Math.min(Math.floor(previousCount / 2), previousCount - 5);
    message = `Upcoming events fell from ${previousCount} to ${currentCount} in the same date range; verify the source export.`;
  }
  if (code && !result.warnings.some(warning => warning.code === code)) {
    result.warnings.push({
      code, message, threshold, baselineUpcomingCount: previousCount,
      detectedAt: now.toISOString(), expiresAt: new Date(stamp + DAY).toISOString(),
    });
  }
  return result;
}

// Use stable, credential-free messages for command-line and monitoring output.
// A source without a configured optional integration is informational.
export function calendarHealth(data, now = new Date()) {
  if (!Array.isArray(data?.sources) || !Array.isArray(data?.events)) throw new Error("Response is not calendar JSON (sources and events arrays are required).");
  const stamp = +now;
  const sources = data.sources.map(source => {
    const issues = [];
    if (source.state !== "unconfigured") {
      if (source.state !== "current") issues.push({ code: "source-unhealthy", message: `Source is ${source.state || "missing a status"}.` });
      // An unchanged repo snapshot intentionally keeps its original timestamp.
      // Sync failures are reported by the Action, not inferred from file age.
      if (data.storage !== "repository" && (!Number.isFinite(Date.parse(source.updatedAt)) || stamp - Date.parse(source.updatedAt) > DAY)) {
        issues.push({ code: "source-old", message: "Source has no successful refresh in the last 24 hours." });
      }
      if (source.coverage?.version !== VERSION) {
        issues.push({ code: "coverage-unavailable", message: "Coverage diagnostics are unavailable; deploy the updated calendar service." });
      }
      for (const warning of source.coverage?.warnings || []) {
        if (!warning.expiresAt || Date.parse(warning.expiresAt) > stamp) issues.push(warning);
      }
    }
    return { id: source.id, name: source.name || source.id, state: source.state, coverage: source.coverage, issues };
  });
  return { ok: sources.every(source => !source.issues.length), eventCount: data.events.length, sources };
}
