import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../public/wordpress-bridge.js", import.meta.url), "utf8");
const channel = "ctsg-navigation-v1";

// Execute the production bridge with controlled browser events and history.
// Actual iframe rendering and browser joint history still need browser checks.
function harness(hash = "#/clubs/example", { missingFrame = false } = {}) {
  const listeners = new Map();
  const messages = [];
  const status = { textContent: "Parent script has not run." };
  const entries = [new URL(`https://ctsg.tech.cornell.edu/${hash}`)];
  let index = 0;
  const child = { postMessage: (data, origin) => messages.push({ data, origin }) };
  const frame = {
    src: "https://site.example/ctsg/",
    contentWindow: child,
    addEventListener: (name, fn) => listeners.set(`frame:${name}`, fn),
  };
  const location = {
    get hash() { return entries[index].hash; },
    get href() { return entries[index].href; },
  };
  const history = {
    pushState(_state, _unused, url) {
      const next = new URL(url, location.href);
      entries.splice(index + 1);
      entries.push(next);
      index++;
    },
    replaceState(_state, _unused, url) { entries[index] = new URL(url, location.href); },
  };
  const document = {
    title: "WordPress page title",
    getElementById: (id) => id === "ctsg-bridge-status" ? status : missingFrame ? null : frame,
  };
  runInNewContext(source, {
    URL, location, history, document,
    window: { addEventListener: (name, fn) => listeners.set(name, fn) },
  });
  return {
    entries, location, messages, status, document,
    send(data, overrides = {}) {
      listeners.get("message")({ source: child, origin: "https://site.example", data: { channel, ...data }, ...overrides });
    },
    fire(name) { listeners.get(name)(); },
    back() { index--; listeners.get("popstate")(); },
    forward() { index++; listeners.get("popstate")(); },
  };
}

test("initial parent deep link wins, including after an iframe reload", () => {
  const h = harness();
  assert.equal(h.messages.at(-1).data.route, "/clubs/example");
  assert.equal(h.messages.at(-1).origin, "https://site.example");
  h.send({ type: "ready" });
  h.fire("frame:load");
  assert.equal(h.messages.at(-1).data.route, "/clubs/example");
  assert.equal(h.entries.length, 1);
});

test("clicks add one parent entry; repeated clicks and history restoration add none", () => {
  const h = harness("#/");
  h.send({ type: "navigate", route: "/clubs" });
  h.send({ type: "navigate", route: "/clubs/example" });
  h.send({ type: "navigate", route: "/clubs/example" });
  assert.equal(h.entries.length, 3);
  h.back();
  assert.equal(h.messages.at(-1).data.route, "/clubs");
  h.back();
  assert.equal(h.messages.at(-1).data.route, "/");
  h.forward();
  assert.equal(h.messages.at(-1).data.route, "/clubs");
  h.fire("hashchange");
  assert.equal(h.entries.length, 3);
});

test("child titles follow deep links, navigation, Back/Forward, and reloads without adding history", () => {
  const h = harness("#/members");
  const replyWithTitle = (title) => h.send({ type: "title", route: h.messages.at(-1).data.route, title });
  replyWithTitle("People | CTSG");
  assert.equal(h.document.title, "People | CTSG");
  h.send({ type: "navigate", route: "/events" });
  replyWithTitle("Event Calendar | CTSG");
  assert.equal(h.document.title, "Event Calendar | CTSG");
  h.back();
  replyWithTitle("People | CTSG");
  assert.equal(h.document.title, "People | CTSG");
  h.forward();
  replyWithTitle("Event Calendar | CTSG");
  assert.equal(h.document.title, "Event Calendar | CTSG");
  h.fire("frame:load");
  replyWithTitle("Event Calendar | CTSG");
  assert.equal(h.document.title, "Event Calendar | CTSG");
  assert.equal(h.entries.length, 2);
});

test("rejects untrusted, malformed, and stale title messages", () => {
  const h = harness("#/members");
  const titleMessage = { type: "title", route: "/members", title: "People | CTSG" };
  h.send(titleMessage, { origin: "https://attacker.example" });
  h.send(titleMessage, { source: {} });
  h.send({ ...titleMessage, channel: "other" });
  h.send({ ...titleMessage, route: "/events" });
  h.send({ ...titleMessage, route: {} });
  for (const title of [undefined, null, {}, 1, "", "   ", "a".repeat(301)]) {
    h.send({ ...titleMessage, title });
  }
  assert.equal(h.document.title, "WordPress page title");
  assert.equal(h.entries.length, 1);
  assert.equal(h.messages.length, 1);
});

test("rejects wrong origin, wrong source, malformed messages, and unsafe routes", () => {
  const h = harness("#/");
  h.send({ type: "navigate", route: "/clubs" }, { origin: "https://attacker.example" });
  h.send({ type: "navigate", route: "/clubs" }, { source: {} });
  h.send({}, { data: null });
  h.send({ channel: "other", type: "navigate", route: "/clubs" });
  h.send({ type: "unknown", route: "/clubs" });
  for (const route of ["//attacker.example", "javascript:alert(1)", "/../clubs", "/<script>", {}, 1, "/" + "a".repeat(201)]) {
    h.send({ type: "navigate", route });
  }
  assert.equal(h.location.hash, "#/");
  assert.equal(h.entries.length, 1);
  assert.equal(h.messages.length, 1);
});

test("empty or invalid parent hashes normalize without adding history", () => {
  for (const hash of ["", "#main_content", "#//external.example"]) {
    const h = harness(hash);
    assert.equal(h.location.hash, "#/");
    assert.equal(h.entries.length, 1);
    assert.equal(h.messages.at(-1).data.route, "/");
  }
});

test("unknown local routes are preserved for the child's not-found page", () => {
  const h = harness("#/");
  h.send({ type: "navigate", route: "/missing-page" });
  assert.equal(h.location.hash, "#/missing-page");
  assert.equal(h.messages.at(-1).data.route, "/missing-page");
});

test("diagnostics distinguish script execution, iframe contact, and navigation", () => {
  const h = harness();
  assert.match(h.status.textContent, /Bridge script running/);
  h.send({ type: "ready" });
  assert.match(h.status.textContent, /Iframe detected/);
  h.send({ type: "navigate", route: "/clubs" }, { origin: "https://attacker.example" });
  assert.match(h.status.textContent, /Iframe detected/);
  h.send({ type: "navigate", route: "/clubs" });
  assert.equal(h.status.textContent, "URL synchronization active: /clubs");
});

test("diagnostics identify a missing iframe ID without changing the URL", () => {
  const h = harness("", { missingFrame: true });
  assert.match(h.status.textContent, /no iframe with id="ctsg-site"/);
  assert.equal(h.location.hash, "");
  assert.equal(h.messages.length, 0);
});
