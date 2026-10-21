// "Recently played": a small, device-local list. It is never published to Nostr. Snapshots keep just enough to
// show and replay a track without another relay round-trip.
import { safeHttpsUrl } from "./strify-tracks.js";
import { LIBRARY } from "./strify-config.js";

const KEY_PREFIX = "strify:recent:";
const HEX64 = /^[0-9a-f]{64}$/i;
const clip = (value, max) => String(value || "").slice(0, max);

export function snapshotTrack(track) {
  return {
    key: clip(track.key, 200), eventId: clip(track.eventId, 64), pubkey: clip(track.pubkey, 64), kind: Number(track.kind) || 0, d: clip(track.d, 200),
    createdAt: Number(track.createdAt) || 0, url: track.url, title: clip(track.title, 120), artist: clip(track.artist, 120), album: clip(track.album, 120),
    genre: clip(track.genre, 40), duration: Number(track.duration) || 0, coverArt: track.coverArt || "", playedAt: Date.now(),
  };
}

function revive(item) {
  if (!item || typeof item !== "object" || !item.key || !HEX64.test(item.pubkey || "") || !safeHttpsUrl(item.url)) return null;
  return { ...item, url: safeHttpsUrl(item.url), coverArt: safeHttpsUrl(item.coverArt), description: "" };
}

export function createHistory(storage = globalThis.localStorage, { max = LIBRARY.historyMax } = {}) {
  const keyFor = (owner) => `${KEY_PREFIX}${owner || "anon"}`;
  const read = (owner) => {
    try {
      const parsed = JSON.parse(storage?.getItem(keyFor(owner)) || "[]");
      return Array.isArray(parsed) ? parsed.map(revive).filter(Boolean) : [];
    } catch { return []; }
  };
  const write = (owner, items) => { try { storage?.setItem(keyFor(owner), JSON.stringify(items)); } catch { /* history is optional */ } };
  return {
    list: (owner, limit = max) => read(owner).slice(0, limit),
    record(track, owner) {
      if (!track?.key || !track.url) return;
      const rest = read(owner).filter((item) => item.key !== track.key);
      write(owner, [snapshotTrack(track), ...rest].slice(0, max));
    },
    clear(owner) { try { storage?.removeItem(keyFor(owner)); } catch { /* nothing to clear */ } },
  };
}
