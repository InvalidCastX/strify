// "Now playing" status, using NIP-38 user statuses: kind 30315, d = "music", empty content clears it.
// Public by design (anyone on the relays can read it), expiring (NIP-40 `expiration`), and published only when the user opts in.
import { safeHttpsUrl } from "./strify-tracks.js";

export const STATUS_KIND = 30315;
export const STATUS_D = "music";
const HEX64 = /^[0-9a-f]{64}$/i;
const MAX_FALLBACK_AGE = 10 * 60; // statuses without an expiration tag are only trusted this long
const clip = (v, n) => String(v || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

/** Unsigned status template for the track that is playing now. */
export function buildStatusTemplate(track, { now = Math.floor(Date.now() / 1000), remaining = 0 } = {}) {
  const ttl = Math.min(3600, Math.max(90, Math.ceil(remaining || track.duration || 0) + 30));
  const tags = [["d", STATUS_D], ["expiration", String(now + ttl)], ["title", clip(track.title, 120)]];
  if (track.artist) tags.push(["artist", clip(track.artist, 120)]);
  if (HEX64.test(track.eventId || "")) tags.push(track.kind === 31337 && track.d && HEX64.test(track.pubkey || "") ? ["a", `31337:${track.pubkey}:${track.d}`] : ["e", track.eventId]);
  if (track.coverArt) tags.push(["image", track.coverArt]);
  if (track.url) tags.push(["r", track.url]);
  const text = `${clip(track.title, 120)}${track.artist ? ` — ${clip(track.artist, 120)}` : ""}`;
  return { kind: STATUS_KIND, tags, content: text, created_at: now };
}

/** Empty content clears the status (NIP-38). */
export const buildClearStatusTemplate = (now = Math.floor(Date.now() / 1000)) => ({ kind: STATUS_KIND, tags: [["d", STATUS_D]], content: "", created_at: now });

const tag = (tags, name) => (tags || []).find((t) => t?.[0] === name && typeof t[1] === "string" && t[1])?.[1] || "";

/** A live "now playing" status, or null if it's not music, cleared, expired or malformed. */
export function parseStatusEvent(event, now = Math.floor(Date.now() / 1000)) {
  if (!event || event.kind !== STATUS_KIND || !HEX64.test(event.pubkey || "")) return null;
  if (tag(event.tags, "d") !== STATUS_D) return null;
  const text = clip(event.content, 300);
  if (!text) return null;
  const createdAt = Number(event.created_at) || 0;
  const expires = Number(tag(event.tags, "expiration"));
  const expiresAt = Number.isFinite(expires) && expires > 0 ? expires : createdAt + MAX_FALLBACK_AGE;
  if (expiresAt <= now) return null;
  const e = tag(event.tags, "e");
  const a = tag(event.tags, "a");
  const aParts = a.split(":");
  const trackRef = HEX64.test(e) ? { id: e.toLowerCase() } : aParts[0] === "31337" && HEX64.test(aParts[1] || "") && aParts[2] ? { kind: 31337, pubkey: aParts[1].toLowerCase(), d: aParts.slice(2).join(":") } : null;
  const title = clip(tag(event.tags, "title"), 120) || text.split(" — ")[0];
  return { pubkey: event.pubkey.toLowerCase(), eventId: event.id, createdAt, expiresAt, text, title, artist: clip(tag(event.tags, "artist"), 120), cover: safeHttpsUrl(tag(event.tags, "image")), url: safeHttpsUrl(tag(event.tags, "r")), trackRef };
}

/** Newest status per author wins (so a newer "cleared" one hides an older live one). */
export function liveStatuses(events, now = Math.floor(Date.now() / 1000)) {
  const newest = new Map();
  for (const event of events || []) {
    if (event?.kind !== STATUS_KIND || tag(event.tags, "d") !== STATUS_D || !HEX64.test(event.pubkey || "")) continue;
    const prior = newest.get(event.pubkey);
    if (!prior || event.created_at > prior.created_at) newest.set(event.pubkey, event);
  }
  const live = new Map();
  for (const [pubkey, event] of newest) { const parsed = parseStatusEvent(event, now); if (parsed) live.set(pubkey, parsed); }
  return live;
}
