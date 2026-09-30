import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createWebhookHandler } from "../sync-webhook/worker.mjs";

const env = {
  NOTION_CALENDAR_WEBHOOK_SECRET: "calendar-test-verification-token",
  NOTION_PEOPLE_WEBHOOK_SECRET: "people-test-verification-token",
  GITHUB_DISPATCH_TOKEN: "github-test-token",
};
const event = {
  id: "367cba44-b6f3-4c92-81e7-6a2e9659efd4",
  type: "page.properties_updated",
  timestamp: "2026-09-30T12:00:00Z",
  entity: { id: "153104cd-477e-809d-8dc4-ff2d96ae3090", type: "page" },
  authors: [{ id: "private-person-id" }],
  data: { privateValue: "Never forwarded" },
};
function request({ source = "calendar", value = event, body = JSON.stringify(value), secret, signature } = {}) {
  const signingSecret = secret ?? env[source === "people" ? "NOTION_PEOPLE_WEBHOOK_SECRET" : "NOTION_CALENDAR_WEBHOOK_SECRET"];
  return new Request(`https://relay.example/notion/${source}`, {
    method: "POST", body,
    headers: { "x-notion-signature": signature ?? `sha256=${createHmac("sha256", signingSecret).update(body).digest("hex")}` },
  });
}

test("signed notifications dispatch only public routing hints to the fixed repository", async () => {
  const calls = [];
  const handler = createWebhookHandler({ fetcher: async (...args) => { calls.push(args); return new Response(null, { status: 204 }); } });
  for (const source of ["calendar", "people"]) assert.equal((await handler(request({ source }), env)).status, 202);
  assert.equal(calls.length, 2);
  for (const [index, [url, options]] of calls.entries()) {
    assert.equal(url, "https://api.github.com/repos/ct-student-gov/ctsg-tech-site/dispatches");
    assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_DISPATCH_TOKEN}`);
    assert.equal(options.redirect, "manual");
    assert.deepEqual(JSON.parse(options.body), {
      event_type: "notion-updated",
      client_payload: {
        source: index ? "people" : "calendar", event_id: event.id, event_type: event.type,
        entity_id: event.entity.id, entity_type: "page", timestamp: "2026-09-30T12:00:00.000Z", page_id: event.entity.id,
      },
    });
    assert.doesNotMatch(options.body, /private|Never forwarded|test-token/);
  }
});

test("signature covers exact raw bytes and each connection has its own secret", async () => {
  let calls = 0;
  const handler = createWebhookHandler({ fetcher: async () => { calls++; return new Response(null, { status: 204 }); } });
  const body = JSON.stringify({ ...event, data: { text: "José – 中文" } }, null, 2);
  assert.equal((await handler(request({ body }), env)).status, 202);
  const signature = `sha256=${createHmac("sha256", env.NOTION_CALENDAR_WEBHOOK_SECRET).update(body).digest("hex")}`;
  assert.equal((await handler(request({ body: `${body}\n`, signature }), env)).status, 401);
  assert.equal((await handler(request({ source: "people", secret: env.NOTION_CALENDAR_WEBHOOK_SECRET }), env)).status, 401);
  assert.equal((await handler(request({ signature: "sha256=bad" }), env)).status, 401);
  const unsigned = new Request("https://relay.example/notion/calendar", { method: "POST", body: JSON.stringify(event) });
  assert.equal((await handler(unsigned, env)).status, 401);
  assert.equal(calls, 1);
});

test("initial verification tokens are not accepted or returned by the public relay", async () => {
  const handler = createWebhookHandler({ fetcher: async () => assert.fail("No dispatch expected") });
  const body = JSON.stringify({ verification_token: "sensitive-setup-token" });
  const response = await handler(new Request("https://relay.example/notion/calendar", { method: "POST", body }), env);
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /sensitive-setup-token/);
});

test("unsupported notifications are acknowledged; malformed supported events fail", async () => {
  const handler = createWebhookHandler({ fetcher: async () => assert.fail("No dispatch expected") });
  assert.equal((await handler(request({ value: { ...event, type: "comment.created" } }), env)).status, 204);
  for (const value of [null, [], { ...event, id: "invalid" }, { ...event, timestamp: "invalid" }, { ...event, entity: { id: event.entity.id, type: "block" } }]) {
    assert.equal((await handler(request({ value }), env)).status, 400);
  }
  assert.equal((await handler(request({ body: "{" }), env)).status, 400);
});

test("data-source schema changes trigger reconciliation without pretending to be pages", async () => {
  let sent;
  const handler = createWebhookHandler({ fetcher: async (_url, options) => { sent = JSON.parse(options.body); return new Response(null, { status: 204 }); } });
  const value = { ...event, type: "data_source.schema_updated", entity: { ...event.entity, type: "data_source" } };
  assert.equal((await handler(request({ value }), env)).status, 202);
  assert.equal(sent.client_payload.entity_type, "data_source");
  assert.equal(Object.hasOwn(sent.client_payload, "page_id"), false);
});

test("concurrent delivery retries share one dispatch and successful duplicates are suppressed", async () => {
  let release;
  let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const handler = createWebhookHandler({ fetcher: async () => { calls++; await pending; return new Response(null, { status: 204 }); } });
  const first = handler(request(), env);
  const second = handler(request(), env);
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [202, 202]);
  assert.equal((await handler(request(), env)).status, 202);
  assert.equal(calls, 1);
});

test("GitHub rejection or network failures stay retryable and leak no response details", async () => {
  for (const outcome of [302, 403, 429, 500, 200, "network"]) {
    let calls = 0;
    const handler = createWebhookHandler({ fetcher: async () => {
      calls++;
      if (calls === 1) {
        if (outcome === "network") throw new Error("sensitive network details");
        return new Response("sensitive upstream details", { status: outcome });
      }
      return new Response(null, { status: 204 });
    } });
    const failed = await handler(request(), env);
    assert.equal(failed.status, 502);
    assert.doesNotMatch(await failed.text(), /sensitive/);
    assert.equal((await handler(request(), env)).status, 202);
    assert.equal(calls, 2);
  }
});

test("duplicates can expire or reach a new isolate without preventing a safe reconciliation", async () => {
  let time = 0;
  let calls = 0;
  const options = { now: () => time, fetcher: async () => { calls++; return new Response(null, { status: 204 }); } };
  const handler = createWebhookHandler(options);
  assert.equal((await handler(request(), env)).status, 202);
  time += 26 * 60 * 60 * 1000;
  assert.equal((await handler(request(), env)).status, 202);
  assert.equal((await createWebhookHandler(options)(request(), env)).status, 202);
  assert.equal(calls, 3);
});

test("routes, methods, configuration and actual streamed body sizes are bounded", async () => {
  const handler = createWebhookHandler({ fetcher: async () => assert.fail("No dispatch expected") });
  assert.equal((await handler(new Request("https://relay.example/unrelated"), env)).status, 404);
  const method = await handler(new Request("https://relay.example/notion/calendar"), env);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "POST");
  assert.equal((await handler(request(), {})).status, 503);
  assert.equal((await handler(request({ body: "x".repeat(65537) }), env)).status, 413);
  assert.equal((await handler(request(), { ...env, GITHUB_DISPATCH_TOKEN: "" })).status, 503);
});
