import test from "node:test";
import assert from "node:assert/strict";
import { sourceCoverage, calendarHealth } from "../calendar/coverage.mjs";

const now = new Date("2026-09-30T12:00:00Z");
const source = { id: "example", name: "Example" };
const events = (count, start = "2026-10-05T12:00:00Z") => Array.from({ length: count }, (_, id) => ({ id: String(id), start, end: start }));
const snapshot = (count, updatedAt = "2026-09-30T11:00:00Z", extra = {}) => ({ events: events(count), updatedAt, coverage: { version: 1, warnings: [] }, ...extra });

test("coverage flags a successful empty export and major losses without retaining events", () => {
  const empty = { events: [] };
  const lost = sourceCoverage(source, empty, snapshot(2), now);
  assert.equal(lost.eventCount, 0);
  assert.equal(lost.previousUpcomingCount, 2);
  assert.equal(lost.warnings[0].code, "sudden-empty");
  assert.deepEqual(empty.events, []);
  const partial = sourceCoverage(source, snapshot(5), snapshot(10), now);
  assert.equal(partial.warnings[0].code, "large-drop");
  assert.equal(sourceCoverage(source, snapshot(6), snapshot(10), now).warnings.length, 0);
  assert.equal(sourceCoverage(source, snapshot(1), snapshot(5), now).warnings.length, 0);
});

test("coverage does not mistake ended events or a different import horizon for loss", () => {
  const previous = snapshot(0, "2026-09-29T11:00:00Z", { events: events(10, "2026-09-29T12:00:00Z") });
  assert.equal(sourceCoverage(source, { events: [] }, previous, now).warnings.length, 0);
  const outOfRange = snapshot(10, "2026-09-30T11:00:00Z", { events: events(10, "2027-03-01T12:00:00Z") });
  const narrowed = { events: [], window: { end: "2027-01-01" } };
  assert.equal(sourceCoverage(source, narrowed, outOfRange, now).warnings.length, 0);
});

test("coverage ignores unknown, stale, future, and incompatible baselines", () => {
  for (const previous of [
    null,
    snapshot(10, "2026-09-22T11:00:00Z"),
    snapshot(10, "2026-10-01T11:00:00Z"),
    snapshot(10, undefined, { coverage: { version: 0 } }),
    snapshot(10, undefined, { state: "stale" }),
    { events: events(10) },
  ]) {
    const coverage = sourceCoverage(source, { events: [] }, previous, now);
    assert.deepEqual(coverage.warnings, []);
    assert.equal(coverage.previousUpcomingCount, null);
  }
  assert.equal(sourceCoverage(source, { events: [] }, snapshot(0), now).warnings.length, 0);
});

test("coverage warnings survive another refresh for 24 hours and clear after recovery", () => {
  const failed = snapshot(2, now.toISOString());
  failed.coverage = sourceCoverage(source, failed, snapshot(10), now);
  const later = new Date(+now + 60 * 60 * 1000);
  const repeated = sourceCoverage(source, snapshot(2), failed, later);
  assert.equal(repeated.warnings.length, 1);
  assert.equal(repeated.warnings[0].detectedAt, now.toISOString());
  assert.equal(repeated.warnings[0].expiresAt, "2026-10-01T12:00:00.000Z");
  assert.deepEqual(sourceCoverage(source, snapshot(6), failed, later).warnings, []);
  assert.deepEqual(sourceCoverage(source, snapshot(2), failed, new Date("2026-10-01T12:00:00Z")).warnings, []);
});

test("health distinguishes optional integrations, stale sources, and missing diagnostics", () => {
  const fresh = { ...source, state: "current", updatedAt: now.toISOString(), coverage: sourceCoverage(source, snapshot(2), null, now) };
  const data = { sources: [fresh, { id: "clubs", state: "unconfigured" }], events: events(2) };
  assert.equal(calendarHealth(data, now).ok, true);
  const stale = calendarHealth({ ...data, sources: [{ ...fresh, state: "stale", updatedAt: "2026-09-28T00:00:00Z" }] }, now);
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.sources[0].issues.map(issue => issue.code), ["source-unhealthy", "source-old"]);
  const oldDeployment = calendarHealth({ ...data, sources: [{ ...fresh, coverage: undefined }] }, now);
  assert.equal(oldDeployment.sources[0].issues[0].code, "coverage-unavailable");
  assert.throws(() => calendarHealth({ error: "no calendar" }), /not calendar JSON/);
});

test("health flags active count warnings but does not keep expired warnings", () => {
  const coverage = sourceCoverage(source, { events: [] }, snapshot(2), now);
  const data = { sources: [{ ...source, state: "current", updatedAt: now.toISOString(), coverage }], events: [] };
  assert.equal(calendarHealth(data, now).ok, false);
  data.sources[0].updatedAt = "2026-10-01T12:00:00Z";
  assert.equal(calendarHealth(data, new Date("2026-10-01T12:00:00Z")).ok, true);
});
