const projectToken = "phc_C8597Um9hmVBwDYBLBG8pEvssLHUJ6qqNDe5WNQNz6ts";
const apiHost = "https://us.i.posthog.com";
const productionHosts = new Set(["ct-student-gov.github.io", "ctsg.tech.cornell.edu"]);
let lastRoute = null;
let loading = false;
let unavailable = false;
let client = null;
const pending = [];

// The renderer owns pageviews, including routes restored by the WordPress bridge.
export function trackPageView(route, title) {
  if (unavailable || !productionHosts.has(location.hostname) || route === lastRoute) return;
  lastRoute = route;
  const url = new URL(location.href);
  url.hash = route;
  const properties = { $current_url: url.href, $pathname: route, page_title: title };
  if (client) {
    client.capture("$pageview", properties);
    return;
  }
  pending.push(properties);
  if (loading) return;
  loading = true;
  const script = document.createElement("script");
  script.src = "https://us-assets.i.posthog.com/static/array.js";
  script.async = true;
  script.crossOrigin = "anonymous";
  script.onload = () => {
    window.posthog.init(projectToken, {
      api_host: apiHost,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_performance: false,
      capture_exceptions: false,
      rageclick: false,
      disable_session_recording: true,
      disable_surveys: true,
      advanced_disable_flags: true,
      person_profiles: "never",
      before_send: event => event.event === "$pageview" ? event : null,
      loaded: posthog => {
        client = posthog;
        for (const page of pending.splice(0)) client.capture("$pageview", page);
      },
    });
  };
  // An unavailable analytics service must not interrupt the website.
  script.onerror = () => { unavailable = true; pending.length = 0; };
  document.head.append(script);
}
