// Match only event-specific links, never a department home page or an academic
// calendar shared by many dates. Include the start to preserve separate sessions.
function eventLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "cornelltech.campusgroups.com") {
      const id = url.searchParams.get("id");
      if (/^\d+$/.test(id || "") && /\/(?:rsvp|event_details)(?:$|\/)/.test(url.pathname)) return `campusgroups:${id}`;
    }
    if (url.hostname === "tech.cornell.edu" && /^\/events\/[^/]+\/?$/.test(url.pathname) && !url.pathname.includes("submit-an-event")) return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
    if (url.hostname === "events.cornell.edu" && /^\/event\/[^/]+\/?$/.test(url.pathname)) return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch { /* An absent or invalid link cannot establish identity. */ }
  return null;
}

function combine(previous, next) {
  const publicDetails = !next.detailsRedacted ? next : !previous.detailsRedacted ? previous : null;
  return {
    ...previous, ...next,
    // The first source keeps its subscription UID and primary filter category.
    id: previous.id, source: previous.source, category: previous.category,
    ...(publicDetails ? { description: publicDetails.description, location: publicDetails.location, detailsRedacted: false } : {}),
    audienceTags: [...new Set([...(previous.audienceTags || []), ...(next.audienceTags || [])])],
    sourceIds: [...new Set([...(previous.sourceIds || [previous.source]), ...(next.sourceIds || [next.source])])],
    sourceCategories: { ...(previous.sourceCategories || { [previous.source]: previous.category }), ...(next.sourceCategories || { [next.source]: next.category }) },
  };
}

export function mergeEvents(events) {
  const groups = new Map();
  const keys = new Map();
  for (const event of events) {
    const eventKeys = [`id:${event.id}`];
    for (const value of [event.url, event.registrationUrl]) {
      const link = eventLink(value);
      if (link) eventKeys.push(`link:${link}:${event.start}`);
    }
    const matches = [...new Set(eventKeys.map(key => keys.get(key)).filter(key => key !== undefined))];
    const group = [...groups.keys()].find(key => matches.includes(key)) ?? event.id;
    let merged = groups.get(group);
    for (const other of matches.filter(key => key !== group)) {
      merged = combine(merged, groups.get(other));
      groups.delete(other);
      for (const [key, value] of keys) if (value === other) keys.set(key, group);
    }
    groups.set(group, merged ? combine(merged, event) : { ...event });
    for (const key of eventKeys) keys.set(key, group);
  }
  return [...groups.values()];
}
