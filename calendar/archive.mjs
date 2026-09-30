import { wallTime, ZONE } from "./sources.mjs";

const PREFIX = "calendar-archive-v1:";
const identity = (source, id) => `${PREFIX}${encodeURIComponent(source)}:${encodeURIComponent(id)}`;

// Production uses the existing SQLite-backed Durable Object's storage, not
// Workers KV. Keep an in-memory index while the object is awake so ordinary
// calendar reads do not reread or rewrite every historical event.
export class CalendarArchive {
  constructor(storage) {
    this.storage = storage;
    this.records = new Map();
    this.ready = null;
  }

  async load() {
    if (!this.ready) {
      this.ready = (async () => {
        if (this.storage) this.records = await this.storage.list({ prefix: PREFIX });
      })().catch(error => { this.ready = null; throw error; });
    }
    await this.ready;
  }

  has(source, id) {
    return this.records.has(identity(source, id));
  }

  events(source) {
    return [...this.records.values()].filter(record => record.source === source).map(record => record.event);
  }

  // A specific Notion edit can correct or withdraw a historical event. Normal
  // feed omissions never call this; they leave the permanent archive intact.
  async remove(source, id) {
    await this.load();
    const key = identity(source, id);
    if (!this.records.has(key)) return;
    if (this.storage) await this.storage.delete(key);
    this.records.delete(key);
  }

  async capture(source, events, now) {
    await this.load();
    for (const event of events) {
      // Ongoing and upcoming events stay in the ordinary refresh path.
      const value = event.end || event.start;
      const end = Date.parse(event.allDay && /^\d{4}-\d\d-\d\d$/.test(value) ? wallTime(`${value}T00:00:00`, ZONE) : value);
      if (!event.id || !Number.isFinite(end) || end > +now || this.has(source, event.id)) continue;
      const key = identity(source, event.id);
      const record = { source, archivedAt: now.toISOString(), event: structuredClone(event) };
      // Only mark the event archived after its persistent write succeeds. A
      // quota/storage failure leaves the live cache available for a later retry.
      if (this.storage) await this.storage.put(key, record);
      this.records.set(key, record);
    }
  }
}
