// Relay access for strify. Separate from the route investigator so playback-related lookups survive route changes.
// Subscriptions are one-shot (collectEvents closes them on EOSE/timeout); sockets close after an idle period.
import { RelayManager, collectEvents } from "./nostr-core.js";

const IDLE_MS = 60_000;

export class StrifyNet {
  constructor() { this.rm = new RelayManager([]); this.idleTimer = null; }
  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.rm.closeAll(); }, IDLE_MS);
  }
  async connect(urls, ms = 3500) {
    const wanted = [...new Set((urls || []).filter((u) => /^wss:\/\//i.test(u)))];
    for (const url of wanted) if (!this.rm.relayUrls.includes(url)) this.rm.relayUrls.push(url);
    const results = await Promise.allSettled(wanted.map((url) => this.rm.connect(url, ms)));
    this.touch();
    return wanted.filter((_, i) => results[i].status === "fulfilled");
  }
  /** Throws when none of `urls` could be reached; otherwise resolves with the deduplicated events. */
  async fetch(filters, { urls, timeout = 6000 } = {}) {
    const live = await this.connect(urls);
    if (!live.length) throw new Error("Couldn't reach any relay.");
    const events = await collectEvents(this.rm, filters, { timeout, relayUrls: live });
    this.touch();
    return events;
  }
  close() { clearTimeout(this.idleTimer); this.rm.closeAll(); }
}
