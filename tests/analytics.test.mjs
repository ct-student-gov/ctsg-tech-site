import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = (await readFile(new URL("../public/analytics.js", import.meta.url), "utf8"))
  .replace("export function trackPageView", "function trackPageView");

function harness(hostname = "ct-student-gov.github.io") {
  const scripts = [];
  const events = [];
  let config;
  const client = { capture: (event, properties) => events.push({ event, properties }) };
  const context = {
    URL,
    location: { hostname, href: `https://${hostname}/ctsg-tech-site/public/#/` },
    window: { posthog: { init(_token, options) { config = options; } } },
    document: { createElement: () => ({}), head: { append: script => scripts.push(script) } },
  };
  runInNewContext(source, context);
  return {
    scripts, events,
    track: context.trackPageView,
    get config() { return config; },
    ready() { scripts[0].onload(); config.loaded(client); },
  };
}

test("local previews do not load PostHog or send visits", () => {
  for (const hostname of ["localhost", "127.0.0.1", "preview.example"]) {
    const h = harness(hostname);
    h.track("/", "About CTSG | CTSG");
    assert.equal(h.scripts.length, 0);
    assert.equal(h.events.length, 0);
  }
});

test("visits made while the SDK loads retain their own route and title", () => {
  const h = harness();
  h.track("/", "About CTSG | CTSG");
  h.track("/events", "Event Calendar | CTSG");
  h.track("/events", "Event Calendar | CTSG");
  assert.equal(h.scripts.length, 1);
  assert.equal(h.events.length, 0);
  h.ready();
  assert.deepEqual(h.events.map(e => e.properties.$pathname), ["/", "/events"]);
  assert.equal(h.events[1].properties.page_title, "Event Calendar | CTSG");
  assert.equal(new URL(h.events[1].properties.$current_url).hash, "#/events");
});

test("repeated bridge/history renders count once, but returning to a page counts again", () => {
  const h = harness("ctsg.tech.cornell.edu");
  h.track("/events", "Event Calendar | CTSG");
  h.ready();
  h.track("/events", "Event Calendar | CTSG");
  h.track("/members", "People | CTSG");
  h.track("/members", "People | CTSG");
  h.track("/events", "Event Calendar | CTSG");
  assert.deepEqual(h.events.map(e => e.properties.$pathname), ["/events", "/members", "/events"]);
});

test("only pageviews can be sent; recording and automatic interactions are disabled", () => {
  const h = harness();
  h.track("/", "About CTSG | CTSG");
  h.ready();
  assert.equal(h.config.capture_pageview, false);
  assert.equal(h.config.capture_pageleave, false);
  assert.equal(h.config.autocapture, false);
  assert.equal(h.config.disable_session_recording, true);
  assert.equal(h.config.api_host, "https://us.i.posthog.com");
  assert.equal(h.config.before_send({ event: "$autocapture" }), null);
  assert.equal(h.config.before_send({ event: "$snapshot" }), null);
  const pageview = { event: "$pageview" };
  assert.equal(h.config.before_send(pageview), pageview);
});

test("a blocked SDK does not break navigation or retry on every page", () => {
  const h = harness();
  h.track("/", "About CTSG | CTSG");
  h.scripts[0].onerror();
  assert.doesNotThrow(() => h.track("/events", "Event Calendar | CTSG"));
  assert.equal(h.scripts.length, 1);
  assert.equal(h.events.length, 0);
});
