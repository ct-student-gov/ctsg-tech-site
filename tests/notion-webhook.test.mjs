import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createWebhookHandler, NotionSyncQueue } from "../sync-webhook/worker.mjs";

const BATCH_INTERVAL_MS = 5 * 60 * 1000;

const secrets = {
  NOTION_CALENDAR_WEBHOOK_SECRET: "calendar-test-verification-token",
  NOTION_PEOPLE_WEBHOOK_SECRET: "people-test-verification-token",
  NOTION_BLOG_WEBHOOK_SECRET: "blog-test-verification-token",
  GITHUB_DISPATCH_TOKEN: "github-test-token",
};
const event = {
  id: "367cba44-b6f3-4c92-81e7-6a2e9659efd4", type: "page.properties_updated",
  timestamp: "2026-09-30T12:00:00Z",
  entity: { id: "153104cd-477e-809d-8dc4-ff2d96ae3090", type: "page" },
  authors: [{ id: "private-person-id" }], data: { privateValue: "Never forwarded" },
};
function request({ source = "calendar", value = event, body = JSON.stringify(value), secret, signature } = {}) {
  const signingSecret = secret ?? secrets[`NOTION_${source.toUpperCase()}_WEBHOOK_SECRET`];
  return new Request(`https://relay.example/notion/${source}`, {
    method: "POST", body,
    headers: { "x-notion-signature": signature ?? `sha256=${createHmac("sha256", signingSecret).update(body).digest("hex")}` },
  });
}
function connection(fetcher = async () => new Response(null, { status: 202 })) {
  return { ...secrets, SYNC_QUEUE: {
    idFromName: name => { assert.equal(name, "notion-updates"); return name; },
    get: () => ({ fetch: fetcher }),
  } };
}
function queueFixture({ fetcher = async () => new Response(null, { status: 204 }) } = {}) {
  let time = 0, alarmAt = null, gate = Promise.resolve();
  const values = new Map(), calls = [];
  const storage = {
    get: async key => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    setAlarm: async at => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; },
    transaction: async fn => { const before = structuredClone(values), beforeAlarm = alarmAt;
      try { return await fn(); } catch (error) { values.clear(); for (const pair of before) values.set(...pair); alarmAt = beforeAlarm; throw error; }
    },
  };
  const ctx = { storage, blockConcurrencyWhile: fn => {
    const result = gate.then(fn); gate = result.catch(() => {}); return result;
  } };
  const options = { now: () => time, fetcher: async (...args) => { calls.push(args); return fetcher(...args); } };
  const makeQueue = () => new NotionSyncQueue(ctx, secrets, options);
  const queue = makeQueue();
  const enqueue = (source = "people", page_id = event.entity.id, target = queue) => target.fetch(new Request("https://queue.internal/", {
    method: "POST", body: JSON.stringify({ source, ...(page_id ? { page_id } : {}) }),
  }));
  const fire = async (target = queue) => { alarmAt = null; await target.alarm(); };
  return { queue, makeQueue, storage, calls, enqueue, fire, setTime: value => { time = value; }, alarmAt: () => alarmAt };
}

test("signed notifications queue routing hints without sending GitHub requests", async () => {
  const calls = [], handler = createWebhookHandler();
  const env = connection(async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response(null, { status: 202 }); });
  for (const source of ["calendar", "people"]) assert.equal((await handler(request({ source }), env)).status, 202);
  assert.deepEqual(calls.map(hint => hint.source), ["calendar", "people"]);
  assert.ok(calls.every(hint => hint.page_id === event.entity.id));
  assert.doesNotMatch(JSON.stringify(calls), /private|Never forwarded|test-token/);
});

test("Blog notifications authenticate independently and mixed batches identify every affected source", async () => {
  const sent = [];
  const handler = createWebhookHandler();
  const env = connection(async (_url, options) => { sent.push(JSON.parse(options.body)); return new Response(null, { status: 202 }); });
  assert.equal((await handler(request({ source: "blog", secret: secrets.NOTION_PEOPLE_WEBHOOK_SECRET }), env)).status, 401);
  assert.equal((await handler(request({ source: "blog" }), env)).status, 202);
  assert.equal(sent[0].source, "blog");
  const f = queueFixture();
  await f.enqueue("blog"); await f.enqueue("people"); await f.enqueue("calendar");
  f.setTime(BATCH_INTERVAL_MS); await f.fire();
  assert.deepEqual(JSON.parse(f.calls[0][1].body).client_payload, {
    source: "multiple", sources: ["blog", "calendar", "people"], page_ids: [event.entity.id],
  });
});

test("signature covers raw bytes and each connection has its own secret", async () => {
  let calls = 0;
  const env = connection(async () => { calls++; return new Response(null, { status: 202 }); });
  const handler = createWebhookHandler(), body = JSON.stringify({ ...event, data: { text: "José – 中文" } }, null, 2);
  assert.equal((await handler(request({ body }), env)).status, 202);
  const signature = `sha256=${createHmac("sha256", secrets.NOTION_CALENDAR_WEBHOOK_SECRET).update(body).digest("hex")}`;
  assert.equal((await handler(request({ body: `${body}\n`, signature }), env)).status, 401);
  assert.equal((await handler(request({ source: "people", secret: secrets.NOTION_CALENDAR_WEBHOOK_SECRET }), env)).status, 401);
  assert.equal((await handler(request({ signature: "sha256=bad" }), env)).status, 401);
  const unsigned = new Request("https://relay.example/notion/calendar", { method: "POST", body: JSON.stringify(event) });
  assert.equal((await handler(unsigned, env)).status, 401);
  assert.equal(calls, 1);
});

test("verification, unsupported notifications and malformed events never enter the queue", async () => {
  const env = connection(async () => assert.fail("No queue request expected")), handler = createWebhookHandler();
  const response = await handler(new Request("https://relay.example/notion/calendar", { method: "POST", body: JSON.stringify({ verification_token: "sensitive-setup-token" }) }), env);
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /sensitive-setup-token/);
  assert.equal((await handler(request({ value: { ...event, type: "comment.created" } }), env)).status, 204);
  for (const value of [null, [], { ...event, id: "invalid" }, { ...event, timestamp: "invalid" }, { ...event, entity: { id: event.entity.id, type: "block" } }]) {
    assert.equal((await handler(request({ value }), env)).status, 400);
  }
  assert.equal((await handler(request({ body: "{" }), env)).status, 400);
});

test("data-source changes queue their source without pretending to be pages", async () => {
  let sent;
  const env = connection(async (_url, options) => { sent = JSON.parse(options.body); return new Response(null, { status: 202 }); });
  const value = { ...event, type: "data_source.schema_updated", entity: { ...event.entity, type: "data_source" } };
  assert.equal((await createWebhookHandler()(request({ value }), env)).status, 202);
  assert.equal(sent.entity_type, "data_source");
  assert.equal(Object.hasOwn(sent, "page_id"), false);
});

test("concurrent notification retries share one enqueue and a failed enqueue stays retryable", async () => {
  let calls = 0;
  const env = connection(async () => { calls++; return new Response("sensitive details", { status: calls === 1 ? 503 : 202 }); });
  const handler = createWebhookHandler();
  const failed = await handler(request(), env);
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /sensitive/);
  assert.deepEqual((await Promise.all([handler(request(), env), handler(request(), env)])).map(r => r.status), [202, 202]);
  assert.equal((await handler(request(), env)).status, 202);
  assert.equal(calls, 2);
});

test("rapid edits and both connections produce one batch after five minutes, including the last edit", async () => {
  const f = queueFixture();
  await f.enqueue();
  assert.equal(f.alarmAt(), BATCH_INTERVAL_MS);
  f.setTime(BATCH_INTERVAL_MS - 1);
  const lastPage = "253104cd-477e-809d-8dc4-ff2d96ae3090";
  await f.enqueue("calendar", lastPage);
  await f.enqueue("people");
  assert.equal(f.alarmAt(), BATCH_INTERVAL_MS);
  await f.fire();
  assert.equal(f.calls.length, 0);
  f.setTime(BATCH_INTERVAL_MS);
  await f.fire();
  assert.equal(f.calls.length, 1);
  const [url, options] = f.calls[0];
  assert.equal(url, "https://api.github.com/repos/ct-student-gov/ctsg-tech-site/dispatches");
  assert.equal(options.headers.Authorization, `Bearer ${secrets.GITHUB_DISPATCH_TOKEN}`);
  assert.equal(options.redirect, "manual");
  assert.deepEqual(JSON.parse(options.body), { event_type: "notion-updated", client_payload: { source: "both", page_ids: [event.entity.id, lastPage] } });
  assert.equal(f.alarmAt(), null);
  assert.doesNotMatch(JSON.stringify(await f.storage.get("batch")), /private|timestamp|test-token/);
});

test("a final edit after dispatch is queued across restarts and cannot dispatch sooner than five minutes", async () => {
  const f = queueFixture();
  await f.enqueue(); f.setTime(BATCH_INTERVAL_MS); await f.fire();
  f.setTime(BATCH_INTERVAL_MS + 1);
  const restarted = f.makeQueue();
  await f.enqueue("people", event.entity.id, restarted);
  await f.fire(restarted);
  assert.equal(f.calls.length, 1);
  assert.equal(f.alarmAt(), 2 * BATCH_INTERVAL_MS + 1);
  f.setTime(2 * BATCH_INTERVAL_MS + 1); await f.fire(restarted);
  assert.equal(f.calls.length, 2);
  await f.fire(restarted); assert.equal(f.calls.length, 2);
});

test("GitHub errors, redirects and ambiguous responses keep the batch for a bounded retry", async () => {
  for (const outcome of [302, 403, 429, 500, 200, "network"]) {
    let attempts = 0;
    const f = queueFixture({ fetcher: async () => {
      if (++attempts === 1) {
        if (outcome === "network") throw new Error("sensitive network details");
        return new Response("sensitive upstream details", { status: outcome });
      }
      return new Response(null, { status: 204 });
    } });
    await f.enqueue(); f.setTime(BATCH_INTERVAL_MS); await f.fire();
    assert.equal(f.alarmAt(), 2 * BATCH_INTERVAL_MS);
    assert.deepEqual((await f.storage.get("batch")).sources, ["people"]);
    f.setTime(BATCH_INTERVAL_MS + 1); await f.fire(); assert.equal(f.calls.length, 1);
    f.setTime(2 * BATCH_INTERVAL_MS); await f.fire(f.makeQueue());
    assert.equal(f.calls.length, 2); assert.equal(f.alarmAt(), null);
  }
});

test("edits arriving while a batch is sent stay queued for the next batch", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = queueFixture({ fetcher: async () => { await pending; return new Response(null, { status: 204 }); } });
  await f.enqueue(); f.setTime(BATCH_INTERVAL_MS);
  const sending = f.fire();
  await new Promise(resolve => setTimeout(resolve, 10));
  const editing = f.enqueue("calendar");
  release(); await Promise.all([sending, editing]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual((await f.storage.get("batch")).sources, ["calendar"]);
  assert.equal(f.alarmAt(), 2 * BATCH_INTERVAL_MS);
});

test("routes, methods, configuration and streamed body sizes are bounded", async () => {
  const handler = createWebhookHandler(), env = connection(async () => assert.fail("No enqueue expected"));
  assert.equal((await handler(new Request("https://relay.example/unrelated"), env)).status, 404);
  const method = await handler(new Request("https://relay.example/notion/calendar"), env);
  assert.equal(method.status, 405); assert.equal(method.headers.get("allow"), "POST");
  assert.equal((await handler(request(), {})).status, 503);
  assert.equal((await handler(request({ body: "x".repeat(65537) }), env)).status, 413);
  for (const key of ["GITHUB_DISPATCH_TOKEN", "SYNC_QUEUE"]) assert.equal((await handler(request(), { ...env, [key]: undefined })).status, 503);
  const f = queueFixture();
  assert.equal((await f.enqueue("invalid")).status, 400);
  assert.equal((await f.enqueue("people", "bad-id")).status, 400);
});
