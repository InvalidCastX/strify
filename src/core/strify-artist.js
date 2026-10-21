// Artist discography logic for strify. Pure functions: no DOM, no relays.
// The artist is the Nostr public key that published the kind 1808 events, never a display name.
import { AUDIO_HEADER_KIND } from "./strify-config.js";
import { parseAccountIdentifier, npubFromHex } from "./nostr-core.js";
import { dedupeTracks } from "./strify-tracks.js";

export const ARTIST_PAGE_SIZE = 40;

/** `?artist=<npub|nprofile|hex>` -> lowercase hex pubkey, or null when absent/invalid. */
export function parseArtistParam(search) {
  const value = new URLSearchParams(search || "").get("artist");
  if (!value) return null;
  const parsed = parseAccountIdentifier(value);
  return parsed.pubkey || null;
}

/** Link to an artist page under `base` ("/" standalone, "/strify" when embedded in friendstr). */
export const artistPath = (pubkey, base = "/") => `${String(base || "/").replace(/\/+$/, "") || "/"}?artist=${encodeURIComponent(npubFromHex(pubkey))}`;

/** Relay filter for one artist's kind 1808 events; `until` pages backwards in time. */
export function artistFilter(pubkey, { until = null, limit = ARTIST_PAGE_SIZE } = {}) {
  return { kinds: [AUDIO_HEADER_KIND], authors: [pubkey], limit, ...(until ? { until } : {}) };
}

/**
 * Keep only playable kind 1808 tracks authored by `pubkey` (relays may ignore the `authors` filter, and a
 * header can reference audio published by someone else), deduplicated by event id, newest first.
 */
export function artistTracksOnly(tracks, pubkey) {
  const want = String(pubkey || "").toLowerCase();
  return dedupeTracks((tracks || []).filter((t) => t?.kind === AUDIO_HEADER_KIND && t.pubkey === want && t.url));
}

/** Merge a freshly fetched page into what is already shown. Returns the new list and how many tracks were new. */
export function mergeArtistPage(existing, incoming, pubkey) {
  const before = new Set((existing || []).map((t) => t.key));
  const tracks = artistTracksOnly([...(existing || []), ...(incoming || [])], pubkey);
  return { tracks, added: tracks.filter((t) => !before.has(t.key)).length };
}

/** Oldest created_at among raw events authored by `pubkey`; the cursor for the next (older) page. */
export function oldestCreatedAt(events, pubkey) {
  const times = (events || []).filter((e) => e?.pubkey === pubkey && Number.isInteger(e.created_at)).map((e) => e.created_at);
  return times.length ? Math.min(...times) : null;
}

/**
 * Decide whether more pages might exist. A page smaller than the limit means the relays ran out.
 * `added === 0` guards against a relay that keeps returning the same events (e.g. many sharing one timestamp).
 */
export function hasMorePages({ scanned, limit = ARTIST_PAGE_SIZE, added, cursorMoved }) {
  return scanned >= limit && added > 0 && cursorMoved;
}

/** The rest of the music once the user's own tracks have been pulled out to the top (no duplicates). */
export function withoutOwn(tracks, own) {
  const ownKeys = new Set((own || []).map((t) => t.key));
  return (tracks || []).filter((t) => !ownKeys.has(t.key));
}
