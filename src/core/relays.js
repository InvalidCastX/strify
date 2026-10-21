// Relay configuration: the list the user reads from and publishes to, persisted in localStorage.
// Order matters: strify uses the first few relays for quick lookups (relay lists, statuses), so the default sits first.

export const DEFAULT_RELAYS = Object.freeze([
  { url: "wss://relay.bchnostr.com", read: true, write: true }, // default
  { url: "wss://relay.damus.io", read: true, write: true },
  { url: "wss://relay.primal.net", read: true, write: true },
  { url: "wss://nos.lol", read: true, write: true },
  { url: "wss://relay.nostr.band", read: true, write: true },
  { url: "wss://relay.snort.social", read: true, write: true },
  { url: "wss://nostr.mom", read: true, write: true },
  { url: "wss://relay.nostr.wine", read: true, write: true },
  { url: "wss://relay.noswhere.com", read: true, write: true },
  { url: "wss://purplepag.es", read: true, write: true },
  { url: "wss://relay.nostr.net", read: true, write: true },
  { url: "wss://offchain.pub", read: true, write: true },
  { url: "wss://relay.ditto.pub", read: true, write: true },
  { url: "wss://relay.nostr.bg", read: true, write: true },
  { url: "wss://nostr.oxtr.dev", read: true, write: true },
  { url: "wss://relay.vertexlab.io", read: true, write: true },
  { url: "wss://relay.nostr.info", read: true, write: true },
  { url: "wss://nostr-pub.wellorder.net", read: true, write: true },
  { url: "wss://relay.nostrplebs.com", read: true, write: true },
  { url: "wss://nostr.fmt.wiz.biz", read: true, write: true },
  { url: "wss://relay.nos.social", read: true, write: true },
]);

export const DEFAULT_RELAY_URL = DEFAULT_RELAYS[0].url;
export const MAX_RELAYS = 60;
const STORAGE_KEY = "strify:relays:v1";
const listeners = new Set();

/** { url } with a clean wss:// URL, or { error }. Accepts "relay.example.com", "wss://relay.example.com/". */
export function normalizeRelayUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) return { error: "Enter a relay address, like wss://relay.example.com." };
  if (/^ws:\/\//i.test(raw)) return { error: "Only secure relays (wss://) work in the browser." };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `wss://${raw}`;
  let url;
  try { url = new URL(raw); } catch { return { error: "That doesn't look like a relay address." }; }
  if (url.protocol !== "wss:") return { error: "Only secure relays (wss://) work in the browser." };
  if (!url.hostname.includes(".") || url.username || url.password) return { error: "That doesn't look like a relay address." };
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return { url: `wss://${url.host.toLowerCase()}${path}${url.search}` };
}

function clean(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const entry = typeof item === "string" ? { url: item, read: true, write: true } : item;
    const result = normalizeRelayUrl(entry?.url);
    if (!result.url || seen.has(result.url)) continue;
    seen.add(result.url);
    out.push({ url: result.url, read: entry.read !== false, write: entry.write !== false });
  }
  return out.slice(0, MAX_RELAYS);
}

export function getRelays() {
  try {
    const saved = clean(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
    if (saved.length) return saved;
  } catch { /* fall back to the defaults */ }
  return clean(DEFAULT_RELAYS);
}

export function setRelays(list) {
  const next = clean(list);
  if (!next.length) return getRelays();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* the list still applies for this session */ }
  cache = next;
  for (const fn of listeners) fn(next);
  return next;
}

let cache = null;
const current = () => cache || (cache = getRelays());

export const readRelays = () => current().filter((r) => r.read).map((r) => r.url);
export const writeRelays = () => current().filter((r) => r.write).map((r) => r.url);
export const resetRelays = () => setRelays(DEFAULT_RELAYS);
export function onRelaysChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Add a relay (read + write). Returns { relays } or { error }. */
export function addRelay(input, flags = {}) {
  const result = normalizeRelayUrl(input);
  if (result.error) return result;
  const list = current();
  if (list.some((r) => r.url === result.url)) return { error: "That relay is already in your list." };
  if (list.length >= MAX_RELAYS) return { error: `You can keep up to ${MAX_RELAYS} relays.` };
  return { relays: setRelays([...list, { url: result.url, read: flags.read !== false, write: flags.write !== false }]) };
}

export function removeRelay(url) {
  const list = current().filter((r) => r.url !== url);
  if (!list.some((r) => r.read)) return { error: "Keep at least one relay you read from." };
  return { relays: setRelays(list) };
}

export function updateRelay(url, patch) {
  const list = current().map((r) => (r.url === url ? { ...r, ...patch } : r));
  if (!list.some((r) => r.read)) return { error: "Keep at least one relay you read from." };
  return { relays: setRelays(list) };
}

/** Merge relays from a NIP-65 (kind 10002) event: adds new ones, never removes or changes existing ones. */
export function mergeRelayListEvent(event) {
  const additions = [];
  for (const tag of event?.tags || []) {
    if (tag?.[0] !== "r") continue;
    const result = normalizeRelayUrl(tag[1]);
    if (!result.url) continue;
    additions.push({ url: result.url, read: tag[2] !== "write", write: tag[2] !== "read" });
  }
  const list = current();
  const fresh = additions.filter((a) => !list.some((r) => r.url === a.url));
  if (fresh.length) setRelays([...list, ...fresh]);
  return fresh.length;
}
