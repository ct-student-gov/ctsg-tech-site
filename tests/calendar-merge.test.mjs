import test from "node:test";
import assert from "node:assert/strict";
import { mergeEvents } from "../calendar/merge.mjs";
import { eventFilter, matchesCalendarSource } from "../public/calendar.js";

const event = { id: "student-affairs:abc", source: "student-affairs", category: "School events", title: "Workshop", start: "2026-10-01T17:00:00.000Z", end: "2026-10-01T18:00:00.000Z", url: "https://cornelltech.campusgroups.com/rsvp?id=123", description: "Public description", location: "Public venue", audienceTags: ["Master's Students"] };

test("student updates keep public detail and subscription identity", () => {
  const student = { ...event, start: "2026-10-02T17:00:00.000Z", description: "See event page", location: "See event page", detailsRedacted: true, audienceTags: ["Technical Programs"] };
  const [merged] = mergeEvents([event, student]);
  assert.equal(merged.id, event.id);
  assert.equal(merged.start, student.start);
  assert.equal(merged.description, event.description);
  assert.equal(merged.location, event.location);
  assert.deepEqual(merged.audienceTags, ["Master's Students", "Technical Programs"]);
});

test("matching registration links merge across departments and retain filter membership", () => {
  const copy = { ...event, id: "career-management:other", source: "career-management", url: event.url + "&tracking=1" };
  const result = mergeEvents([event, copy]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].sourceIds, ["student-affairs", "career-management"]);
  assert.equal(result[0].id, event.id);
  assert.equal(matchesCalendarSource(result[0], new Set(["career-management"])), true);
  assert.equal(matchesCalendarSource(result[0], new Set(["student-affairs"])), false);
  assert.equal(eventFilter(result[0]), "career-management");
  assert.equal(matchesCalendarSource(result[0], new Set(["tech-events"])), false);
});

test("Tech listing can link to the same registration without copying a title", () => {
  const copy = { ...event, id: "tech-events:123", source: "tech-events", title: "Updated Workshop", url: "https://tech.cornell.edu/events/workshop/", registrationUrl: event.url };
  const result = mergeEvents([event, copy]);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, copy.title);
  assert.equal(eventFilter(copy), "student-affairs");
  assert.equal(matchesCalendarSource(copy, new Set(["student-affairs"])), true);
});

test("merged approved CTSG events retain their CTSG filter membership", () => {
  const ctsg = { ...event, id: "notion:1", source: "clubs", category: "CTSG events" };
  const [merged] = mergeEvents([event, ctsg]);
  assert.equal(matchesCalendarSource(merged, new Set(["ctsg"])), true);
  assert.equal(matchesCalendarSource(merged, new Set(["clubs"])), false);
  assert.equal(matchesCalendarSource(merged, new Set(["student-affairs"])), true);
});

test("separate occurrences and shared calendar URLs never collapse", () => {
  const nextSession = { ...event, id: "student-affairs:def", start: "2026-10-02T17:00:00.000Z" };
  assert.equal(mergeEvents([event, nextSession]).length, 2);
  const academic = { ...event, source: "academic", url: "https://registrar.cornell.edu/calendars-exams/academic-calendar" };
  assert.equal(mergeEvents([academic, { ...academic, id: "academic:other", title: "Separate deadline" }]).length, 2);
  assert.equal(mergeEvents([event, { ...event, id: "unrelated", url: "" }]).length, 2);
});

test("a record bridging two known identities merges them once", () => {
  const copy = { ...event, id: "tech-events:1", source: "tech-events", url: "https://tech.cornell.edu/events/workshop/" };
  const bridge = { ...copy, registrationUrl: event.url };
  const result = mergeEvents([event, copy, bridge]);
  assert.equal(result.length, 1);
  assert.deepEqual(new Set(result[0].sourceIds), new Set(["student-affairs", "tech-events"]));
});
