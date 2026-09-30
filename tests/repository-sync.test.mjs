import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncRepository, isRateLimit } from "../scripts/sync-repository.mjs";

const exec = promisify(execFile);
const now = new Date("2026-09-30T23:00:00Z");
const pageId = "153104cd-477e-809d-8dc4-ff2d96ae3090";
const credentials = {
  NOTION_TOKEN: "test-calendar-token",
  NOTION_PEOPLE_TOKEN: "test-people-token",
  CAMPUSGROUPS_STUDENT_AFFAIRS_URL: "https://example.org/test-student-secret",
  CAMPUSGROUPS_CAREER_MANAGEMENT_URL: "https://example.org/test-career-secret",
};

async function fixture(t, { trigger = "schedule", payload = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ctsg-repository-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(console, "log", () => {});
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({ client_payload: payload }));
  const env = { ...credentials, GITHUB_EVENT_NAME: trigger, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: join(root, "output") };
  const calls = [];
  const calendar = async options => { calls.push(["calendar", options]); return { data: { events: [] }, changed: false, warnings: [] }; };
  const people = async options => { calls.push(["people", options]); return { profileCount: 1, downloadedPhotos: 0 }; };
  return { root, env, calls, calendar, people, now };
}

test("daily and manual syncs refresh both services; dispatches refresh only their source", async t => {
  for (const trigger of ["schedule", "workflow_dispatch"]) {
    const state = await fixture(t, { trigger });
    assert.deepEqual(await syncRepository(state), { skipped: false, rateLimited: false });
    assert.deepEqual(state.calls.map(([name]) => name), ["calendar", "people"]);
    assert.equal(state.calls[0][1].notionOnly, false);
    assert.deepEqual(state.calls[0][1].changedPageIds, []);
    assert.equal(state.calls[1][1].root, join(state.root, "public"));
  }
  for (const source of ["calendar", "people"]) {
    const state = await fixture(t, { trigger: "repository_dispatch", payload: { source, page_id: pageId } });
    await syncRepository(state);
    assert.deepEqual(state.calls.map(([name]) => name), [source]);
    assert.deepEqual(state.calls[0][1].changedPageIds, [pageId]);
    if (source === "calendar") assert.equal(state.calls[0][1].notionOnly, true);
  }
});

test("unknown dispatch sources fail before imports and invalid page hints are ignored", async t => {
  const unknown = await fixture(t, { trigger: "repository_dispatch", payload: { source: "anything-else" } });
  await assert.rejects(syncRepository(unknown), /Unknown Notion notification source/);
  assert.equal(unknown.calls.length, 0);
  const invalid = await fixture(t, { trigger: "repository_dispatch", payload: { source: "people", page_id: "../../secrets" } });
  await syncRepository(invalid);
  assert.deepEqual(invalid.calls[0][1].changedPageIds, []);
});

test("first publication forces a complete import even when started by one connection's webhook", async t => {
  const state = await fixture(t, { trigger: "repository_dispatch", payload: { source: "people", page_id: pageId } });
  state.env.SYNC_FULL = "true";
  await syncRepository(state);
  assert.deepEqual(state.calls.map(([name]) => name), ["calendar", "people"]);
  assert.equal(state.calls[0][1].notionOnly, false);
});

test("required secrets are exact for each source and missing configuration prevents partial imports", async t => {
  const cases = [
    { source: null, required: Object.keys(credentials) },
    { source: "calendar", required: ["NOTION_TOKEN", "CAMPUSGROUPS_STUDENT_AFFAIRS_URL", "CAMPUSGROUPS_CAREER_MANAGEMENT_URL"] },
    { source: "people", required: ["NOTION_PEOPLE_TOKEN"] },
  ];
  for (const { source, required } of cases) {
    const state = await fixture(t, { trigger: source ? "repository_dispatch" : "schedule", payload: { source } });
    for (const name of Object.keys(credentials)) if (!required.includes(name)) delete state.env[name];
    await syncRepository(state); // No Inclusion/Belonging connection is required.
    for (const missing of required) {
      state.calls.length = 0;
      const env = { ...state.env, [missing]: "" };
      await assert.rejects(syncRepository({ ...state, env }), error => error.message.includes(`secret ${missing}`));
      assert.equal(state.calls.length, 0);
    }
  }
});

test("a calendar 429 defers People too, skips calls until UTC midnight, then clears cooldown after success", async t => {
  const state = await fixture(t);
  const limited = new Error("Calendar refresh failed", { cause: new Error("Notion request failed (HTTP 429)") });
  await assert.rejects(syncRepository({ ...state, calendar: async () => { throw limited; } }), limited);
  assert.equal(state.calls.length, 0);
  const backoff = join(state.root, "data-sync/backoff.json");
  assert.deepEqual(JSON.parse(await readFile(backoff, "utf8")), { until: "2026-10-01T00:00:00.000Z" });
  assert.equal(await readFile(state.env.GITHUB_OUTPUT, "utf8"), "rate_limited=true\n");

  await writeFile(state.env.GITHUB_EVENT_PATH, JSON.stringify({ client_payload: { source: "people" } }));
  const env = { ...state.env, GITHUB_EVENT_NAME: "repository_dispatch" };
  assert.deepEqual(await syncRepository({ ...state, env, now: new Date("2026-09-30T23:59:59Z") }), { skipped: true, rateLimited: false });
  assert.equal(state.calls.length, 0);
  assert.deepEqual(await syncRepository({ ...state, env, now: new Date("2026-10-01T00:00:00Z") }), { skipped: false, rateLimited: false });
  assert.deepEqual(state.calls.map(([name]) => name), ["people"]);
  await assert.rejects(readFile(backoff), { code: "ENOENT" });
});

test("non-quota failures do not set or extend a cooldown and another trigger can retry", async t => {
  const state = await fixture(t);
  const backoff = join(state.root, "data-sync/backoff.json");
  await mkdir(dirname(backoff), { recursive: true });
  const expired = JSON.stringify({ until: "2026-09-30T00:00:00.000Z" });
  await writeFile(backoff, expired);
  await assert.rejects(syncRepository({ ...state, people: async () => { throw new Error("Invalid published Photo"); } }), /Invalid published Photo/);
  assert.equal(await readFile(backoff, "utf8"), expired);
  await assert.rejects(readFile(state.env.GITHUB_OUTPUT), { code: "ENOENT" });
  assert.deepEqual(state.calls.map(([name]) => name), ["calendar"]);
  state.calls.length = 0;
  await syncRepository(state);
  assert.deepEqual(state.calls.map(([name]) => name), ["calendar", "people"]);
  await assert.rejects(readFile(backoff), { code: "ENOENT" });
  assert.equal(isRateLimit(new Error("HTTP 500")), false);
  assert.equal(isRateLimit(new Error("HTTP 4290")), false);
});

const workflowPath = new URL("../.github/workflows/pages.yml", import.meta.url);
async function workflowStep(name) {
  const lines = (await readFile(workflowPath, "utf8")).split("\n");
  const start = lines.findIndex(line => line === `      - name: ${name}`);
  assert.ok(start >= 0, `Missing workflow step: ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^      - /.test(lines[end])) end++;
  const block = lines.slice(start, end);
  const run = block.findIndex(line => line === "        run: |");
  assert.ok(run >= 0, `Missing shell script: ${name}`);
  const script = [];
  for (const line of block.slice(run + 1)) {
    if (line.trim() && !line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  return { script: script.join("\n"), block: block.join("\n") };
}

async function gitFixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "ctsg-workflow-git-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "working");
  const remote = join(parent, "remote.git");
  await mkdir(root);
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  await exec("git", ["init", "--bare", remote]);
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Sync test");
  await git("config", "user.email", "sync-test@example.invalid");
  await git("config", "core.hooksPath", "/dev/null");
  const files = {
    "public/data/people.js": "original people\n",
    "public/data/calendar.json": "original calendar\n",
    "public/data/calendar.ics": "original subscription\n",
    "public/images/members/original.webp": "original image\n",
    "data-sync/people.json": "original sync state\n",
  };
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
  await git("add", ".");
  await git("commit", "-m", "Initial fixtures");
  await git("remote", "add", "origin", remote);
  await git("push", "-u", "origin", "main");
  const output = join(parent, "output");
  const run = async script => exec("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
    cwd: root, env: { ...process.env, SYNC: "true", SKIPPED: "false", GITHUB_OUTPUT: output },
  });
  return { root, git, run, output };
}

test("workflow failure handling commits only the quota marker, leaving partially prepared public files out of Git", async t => {
  const { root, git, run } = await gitFixture(t);
  await writeFile(join(root, "public/data/calendar.json"), "partially refreshed calendar\n");
  await writeFile(join(root, "public/data/people.js"), "partially refreshed people\n");
  await writeFile(join(root, "data-sync/people.json"), "partially refreshed sync state\n");
  await writeFile(join(root, "data-sync/backoff.json"), '{"until":"2026-10-01T00:00:00.000Z"}\n');
  const step = await workflowStep("Save shared quota cooldown");
  assert.match(step.block, /if: failure\(\) && steps\.sync\.outputs\.rate_limited == 'true'/);
  await run(step.script);
  assert.equal(await git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "data-sync/backoff.json");
  assert.equal(await git("show", "HEAD:public/data/calendar.json"), "original calendar");
  assert.equal(await git("show", "HEAD:public/data/people.js"), "original people");
  assert.equal(await git("show", "HEAD:data-sync/people.json"), "original sync state");
  assert.equal(await git("rev-parse", "HEAD"), await git("rev-parse", "origin/main"));
});

test("workflow skips rebuilding on sync-state-only changes and publishes a changed public snapshot", async t => {
  const { root, git, run, output } = await gitFixture(t);
  await writeFile(join(root, "data-sync/people.json"), "new sync state\n");
  const step = await workflowStep("Check for changes");
  await run(step.script);
  assert.equal(await readFile(output, "utf8"), "publish=false\n");
  assert.equal(await git("diff", "--cached", "--name-only"), "data-sync/people.json");
  await writeFile(output, "");
  await writeFile(join(root, "public/data/people.js"), "new public people\n");
  await run(step.script);
  assert.equal(await readFile(output, "utf8"), "publish=true\n");
});

test("a queued main build replaces its old checkout with the latest committed snapshot", async t => {
  const { root, git, run } = await gitFixture(t);
  const old = await git("rev-parse", "HEAD");
  await writeFile(join(root, "public/data/people.js"), "newer synced people\n");
  await git("add", "public/data/people.js");
  await git("commit", "-m", "A newer completed sync");
  await git("push", "origin", "main");
  const latest = await git("rev-parse", "HEAD");
  await git("checkout", "--detach", old);
  const step = await workflowStep("Use latest repository data for queued main builds");
  assert.match(step.block, /if: github\.ref == 'refs\/heads\/main' && github\.event_name != 'pull_request'/);
  await run(step.script);
  assert.equal(await git("rev-parse", "HEAD"), latest);
  assert.equal(await readFile(join(root, "public/data/people.js"), "utf8"), "newer synced people\n");
});
