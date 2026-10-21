// Parsing and resolving Nostr audio events (kind 1808 audio header, kind 31337 audio track).
// Observed/documented shapes handled here:
//   31337 (zapstr / wavlake style): tags d, title, artist, album, genre, ["media", url, "http"], url, image|cover|thumb|artwork,
//         duration; content is a free-text description or JSON. The media URL is sometimes a wavlake.com *page*, not audio.
//   1808  (as already used by friendstr profile music): JSON content {url,title,artist,coverArt,duration,genre}; a header may
//         instead carry tags and reference its audio track by an `e` or `a` tag, so it is resolved, not assumed playable.
import { AUDIO_HEADER_KIND, AUDIO_TRACK_KIND, DISCOVERY } from "./strify-config.js";

const HEX64 = /^[0-9a-f]{64}$/i;
const NON_AUDIO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com|soundcloud\.com|bandcamp\.com|apple\.com|tidal\.com|deezer\.com|fountain\.fm)$/i;
const WAVLAKE_PAGE = /^https:\/\/(?:www\.)?wavlake\.com\/track\/([0-9a-f-]{8,64})\/?$/i;

export function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.href;
  } catch { return ""; }
}

/** "audio" = hand to <audio>; "wavlake-page" = needs resolving to a stream; "unsupported" = known non-media page. */
export function classifyMediaUrl(value) {
  const href = safeHttpsUrl(value);
  if (!href) return { type: "unsupported", url: "" };
  const page = WAVLAKE_PAGE.exec(href);
  if (page) return { type: "wavlake-page", url: href, wavlakeId: page[1] };
  const host = new URL(href).hostname;
  if (NON_AUDIO_HOSTS.test(host) || /(^|\.)wavlake\.com$/i.test(host) && !/\.(mp3|m4a|ogg|wav|aac|opus|flac)(\?|$)/i.test(href)) return { type: "unsupported", url: href };
  return { type: "audio", url: href };
}

const tagValue = (tags, ...names) => {
  for (const tag of tags || []) if (names.includes(tag?.[0]) && typeof tag[1] === "string" && tag[1].trim()) return tag[1].trim();
  return "";
};

function imetaFields(tags) {
  const out = { url: "", image: "", mime: "" };
  for (const tag of tags || []) {
    if (tag?.[0] !== "imeta") continue;
    const fields = {};
    for (const part of tag.slice(1)) { const i = String(part).indexOf(" "); if (i > 0) fields[part.slice(0, i)] = part.slice(i + 1); }
    if (fields.url && (!fields.m || /^audio\//i.test(fields.m)) && !out.url) out.url = fields.url;
    if (fields.image && !out.image) out.image = fields.image;
  }
  return out;
}

function jsonContent(content) {
  const text = String(content || "").trim();
  if (!text.startsWith("{")) return {};
  try { const data = JSON.parse(text); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; } catch { return {}; }
}

const clip = (value, max) => String(value || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

export function trackKeyOf({ kind, pubkey, d, eventId }) {
  return kind === AUDIO_TRACK_KIND && d ? `${kind}:${pubkey}:${d}` : String(eventId || "");
}

/**
 * Parse one audio event. Returns:
 *   { status: "ready", track }                       – direct playable https audio URL
 *   { status: "needs-resolve", track, wavlakeId }    – URL is a wavlake page; resolve to a stream first
 *   { status: "reference", track, refs }             – metadata only; audio lives in the referenced event(s)
 *   null                                             – not a usable audio event
 */
export function parseAudioEvent(event) {
  if (!event || typeof event !== "object" || !HEX64.test(event.id || "") || !HEX64.test(event.pubkey || "")) return null;
  if (event.kind !== AUDIO_HEADER_KIND && event.kind !== AUDIO_TRACK_KIND) return null;
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const data = jsonContent(event.content);
  const description = event.kind === AUDIO_TRACK_KIND && !String(event.content || "").trim().startsWith("{") ? clip(event.content, 500) : clip(data.description, 500);
  const meta = imetaFields(tags);

  const candidates = [data.url, data.mediaUrl, data.media, tagValue(tags, "media"), tagValue(tags, "url"), meta.url, ...tags.filter((t) => t?.[0] === "r").map((t) => t[1])];
  let media = { type: "unsupported", url: "" };
  for (const candidate of candidates) {
    const result = classifyMediaUrl(candidate);
    if (result.type === "audio") { media = result; break; }
    if (result.type === "wavlake-page" && media.type === "unsupported") media = result;
  }

  const d = tagValue(tags, "d");
  const duration = Number(data.duration ?? tagValue(tags, "duration", "length"));
  const track = {
    eventId: event.id,
    pubkey: event.pubkey.toLowerCase(),
    kind: event.kind,
    d,
    createdAt: Number(event.created_at) || 0,
    url: media.type === "audio" ? media.url : "",
    title: clip(tagValue(tags, "title") || data.title, 120) || "Untitled track",
    artist: clip(tagValue(tags, "artist") || data.artist, 120),
    album: clip(tagValue(tags, "album") || data.album, 120),
    genre: clip(tagValue(tags, "genre") || data.genre, 40),
    description,
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
    coverArt: safeHttpsUrl(data.coverArt || data.image || data.cover || data.artwork || tagValue(tags, "image", "cover", "thumb", "thumbnail", "artwork") || meta.image),
  };
  track.key = trackKeyOf(track);

  if (media.type === "audio") return { status: "ready", track };
  if (media.type === "wavlake-page") return { status: "needs-resolve", track, wavlakeId: media.wavlakeId };
  const refs = [];
  for (const tag of tags) {
    if (tag?.[0] === "e" && HEX64.test(tag[1] || "")) refs.push({ type: "e", id: tag[1].toLowerCase() });
    if (tag?.[0] === "a") {
      const [kind, pubkey, ...rest] = String(tag[1] || "").split(":");
      if (Number(kind) === AUDIO_TRACK_KIND && HEX64.test(pubkey || "") && rest.length) refs.push({ type: "a", pubkey: pubkey.toLowerCase(), d: rest.join(":") });
    }
  }
  return refs.length ? { status: "reference", track, refs } : null;
}

/** A header's own metadata wins over the track it references; the audio URL always comes from the track. */
export function mergeHeaderWithTrack(header, resolved) {
  const pick = (a, b) => (a && a !== "Untitled track" ? a : b);
  return {
    ...resolved,
    eventId: header.eventId,
    pubkey: header.pubkey,
    kind: header.kind,
    d: "",
    createdAt: header.createdAt || resolved.createdAt,
    title: pick(header.title, resolved.title),
    artist: header.artist || resolved.artist,
    album: header.album || resolved.album,
    genre: header.genre || resolved.genre,
    coverArt: header.coverArt || resolved.coverArt,
    duration: header.duration || resolved.duration,
    key: header.eventId,
    sourceTrackKey: resolved.key,
  };
}

/** Keep one track per key (newest wins) — addressable 31337 events replace older versions. */
export function dedupeTracks(tracks) {
  const byKey = new Map();
  for (const track of tracks) {
    const prior = byKey.get(track.key);
    if (!prior || track.createdAt > prior.createdAt) byKey.set(track.key, track);
  }
  return [...byKey.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function resolveWavlakeStream(id, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${DISCOVERY.wavlakeApi}${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`wavlake ${response.status}`);
  const data = await response.json();
  const body = Array.isArray(data) ? data[0] : data;
  const url = safeHttpsUrl(body?.mediaUrl || body?.media_url);
  if (!url) throw new Error("wavlake returned no media URL");
  return { url, coverArt: safeHttpsUrl(body?.artworkUrl || body?.artwork_url), title: clip(body?.title, 120), artist: clip(body?.artist, 120), duration: Number(body?.duration) > 0 ? Math.round(Number(body.duration)) : 0 };
}

/**
 * Turn raw 1808/31337 events into playable tracks. Network helpers are injected so this stays testable:
 *   fetchEvents(filters) -> events   (used to follow header -> track references)
 *   resolveWavlake(id)  -> { url, ... }
 * Returns { tracks, skipped } — skipped counts events that had no playable audio we could verify.
 */
export async function resolveAudioEvents(events, { fetchEvents, resolveWavlake = resolveWavlakeStream, maxWavlake = DISCOVERY.maxWavlakeResolutions } = {}) {
  const ready = [];
  const wavlake = [];
  const references = [];
  let skipped = 0;
  for (const event of events || []) {
    const parsed = parseAudioEvent(event);
    if (!parsed) { skipped++; continue; }
    if (parsed.status === "ready") ready.push(parsed.track);
    else if (parsed.status === "needs-resolve") wavlake.push(parsed);
    else references.push(parsed);
  }

  if (references.length && fetchEvents) {
    const ids = [...new Set(references.flatMap((r) => r.refs.filter((x) => x.type === "e").map((x) => x.id)))];
    const coords = references.flatMap((r) => r.refs.filter((x) => x.type === "a"));
    const filters = [];
    if (ids.length) filters.push({ ids: ids.slice(0, 100) });
    for (const pubkey of new Set(coords.map((c) => c.pubkey))) {
      filters.push({ kinds: [AUDIO_TRACK_KIND], authors: [pubkey], "#d": [...new Set(coords.filter((c) => c.pubkey === pubkey).map((c) => c.d))].slice(0, 50) });
    }
    let fetched = [];
    try { fetched = filters.length ? await fetchEvents(filters) : []; } catch { fetched = []; }
    const parsedRefs = fetched.map(parseAudioEvent).filter((p) => p?.status === "ready");
    const byId = new Map(parsedRefs.map((p) => [p.track.eventId, p.track]));
    const byCoord = new Map(parsedRefs.map((p) => [`${p.track.pubkey}:${p.track.d}`, p.track]));
    for (const header of references) {
      const target = header.refs.map((r) => (r.type === "e" ? byId.get(r.id) : byCoord.get(`${r.pubkey}:${r.d}`))).find(Boolean);
      if (target) ready.push(mergeHeaderWithTrack(header.track, target)); else skipped++;
    }
  } else skipped += references.length;

  const queue = wavlake.slice(0, maxWavlake);
  skipped += wavlake.length - queue.length;
  const cache = new Map();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      try {
        if (!cache.has(item.wavlakeId)) cache.set(item.wavlakeId, await resolveWavlake(item.wavlakeId));
        const stream = cache.get(item.wavlakeId);
        ready.push({ ...item.track, url: stream.url, coverArt: item.track.coverArt || stream.coverArt, duration: item.track.duration || stream.duration || 0 });
      } catch { skipped++; }
    }
  }));

  return { tracks: dedupeTracks(ready.filter((t) => t.url)), skipped };
}

export function trackRef(track) {
  return { id: track.eventId, kind: track.kind, pubkey: track.pubkey, ...(track.d ? { d: track.d } : {}) };
}
