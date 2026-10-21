// Home data layer: one unified Track shape across music kinds, plus parsers and pure builders for the Home carousels.
// Kinds: 1808 (legacy Wavlake header, kept), 30440 track, 30441 album, 30442 artist, 30040/30443 playlists, kind 1 social posts.
// The 30440-30443 tag layouts are read tolerantly (tags first, JSON content as fallback) because they are not yet widely deployed.
import { AUDIO_HEADER_KIND, TRACK_KIND, ALBUM_KIND, ARTIST_KIND, HOME } from "./strify-config.js";
import { parseAudioEvent, safeHttpsUrl, tagValue, imetaFields, jsonContent, clip, isAddressableTrackKind, classifyMediaUrl } from "./strify-tracks.js";
import { assessTrack, isRealMusic } from "./strify-quality.js";

const HEX64 = /^[0-9a-f]{64}$/i;
const AUDIO_FILE = /\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?|#|$)/i;
const IMAGE_FILE = /\.(jpe?g|png|webp|gif)(\?|#|$)/i;

// ── Unified Track ──────────────────────────────────────────────────
/** Adds { id, audioUrl, imageUrl, sourceKind } to a parsed track. id = d tag for 30440, event id otherwise. The legacy fields (url, coverArt, key, eventId, kind…) stay because the player and playlists use them. */
export function toUnified(track) {
  if (!track) return track;
  track.id = track.kind === TRACK_KIND ? (track.d || track.eventId) : track.eventId;
  track.audioUrl = track.url;
  track.imageUrl = track.coverArt;
  track.sourceKind = track.kind;
  return track;
}

/** One event -> unified Track, or null when it has no directly playable audio URL (headers that only reference another event and wavlake pages are resolved asynchronously by resolveAudioEvents). */
export function normalizeTrack(event) {
  const parsed = parseAudioEvent(event);
  return parsed?.status === "ready" ? toUnified(parsed.track) : null;
}

// ── Albums, artists, playlists ─────────────────────────────────────
const MUSIC_REF_KINDS = new Set([AUDIO_HEADER_KIND, TRACK_KIND, 31337]);

function refsFromTags(tags) {
  const refs = [];
  for (const tag of tags || []) {
    if (tag?.[0] === "a") {
      const [kind, pubkey, ...rest] = String(tag[1] || "").split(":");
      if (MUSIC_REF_KINDS.has(Number(kind)) && HEX64.test(pubkey || "") && rest.length) refs.push({ kind: Number(kind), pubkey: pubkey.toLowerCase(), d: rest.join(":"), id: "" });
    } else if (tag?.[0] === "e" && HEX64.test(tag[1] || "")) refs.push({ id: tag[1].toLowerCase() });
  }
  return refs.slice(0, 200);
}

function collectionBase(event, type) {
  if (!event || !HEX64.test(event.id || "") || !HEX64.test(event.pubkey || "")) return null;
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const data = jsonContent(event.content);
  const d = tagValue(tags, "d");
  const meta = imetaFields(tags);
  return {
    type, id: d || event.id, eventId: event.id, d, pubkey: event.pubkey.toLowerCase(), sourceKind: event.kind, createdAt: Number(event.created_at) || 0,
    key: `${event.kind}:${event.pubkey.toLowerCase()}:${d || event.id}`,
    title: clip(tagValue(tags, "title", "name", "alt") || data.title || data.name, 120),
    artist: clip(tagValue(tags, "artist") || data.artist, 120),
    description: clip(tagValue(tags, "description", "summary") || data.description || (String(event.content || "").trim().startsWith("{") ? "" : event.content), 500),
    imageUrl: safeHttpsUrl(data.image || data.cover || data.coverArt || data.picture || tagValue(tags, "image", "cover", "thumb", "picture", "avatar") || meta.image),
    genre: clip(tagValue(tags, "genre") || data.genre, 40),
    refs: refsFromTags(tags), tags,
  };
}

export function parseAlbum(event) {
  if (event?.kind !== ALBUM_KIND) return null;
  const a = collectionBase(event, "album");
  if (!a || !a.title) return null;
  return a;
}

export function parseArtist(event) {
  if (event?.kind !== ARTIST_KIND) return null;
  const a = collectionBase(event, "artist");
  if (!a) return null;
  const data = jsonContent(event.content);
  const name = clip(tagValue(a.tags, "name", "title", "artist") || data.name || data.display_name || data.artist, 80);
  const subject = tagValue(a.tags, "p");
  if (!name) return null;
  return { ...a, name, pubkey: HEX64.test(subject) ? subject.toLowerCase() : a.pubkey, authorPubkey: a.pubkey };
}

/** 30443 is always a music playlist. 30040 is also used for non-music publication indexes, so it only counts when it lists music events or carries a music tag. */
export function parsePlaylist(event) {
  if (event?.kind !== 30040 && event?.kind !== 30443) return null;
  const p = collectionBase(event, "playlist");
  if (!p || !p.title) return null;
  if (event.kind === 30040) {
    const musicTag = p.tags.some((t) => t?.[0] === "t" && ["music", "playlist", "wavlake", "strify"].includes(String(t[1] || "").toLowerCase()));
    if (!p.refs.some((r) => r.kind) && !musicTag) return null;
  }
  return p;
}

// ── Social posts (kind 1) that carry audio ─────────────────────────
export function parseSocialNote(event) {
  if (!event || event.kind !== 1 || !HEX64.test(event.id || "") || !HEX64.test(event.pubkey || "")) return null;
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const text = String(event.content || "");
  const links = [...text.matchAll(/https:\/\/[^\s<>"')\]]+/gi)].map((m) => m[0].replace(/[.,;!?]+$/, ""));
  const meta = imetaFields(tags);
  const candidates = [meta.url, ...tags.filter((t) => t?.[0] === "r").map((t) => t[1]), ...links];
  let url = "";
  for (const c of candidates) { if (!c) continue; const r = classifyMediaUrl(c); if (r.type === "audio" && (c === meta.url || AUDIO_FILE.test(r.url))) { url = r.url; break; } }
  if (!url) return null;
  const image = safeHttpsUrl(meta.image || links.find((l) => IMAGE_FILE.test(l)));
  const title = clip(text.replace(/https?:\/\/\S+/g, " ").replace(/nostr:\S+/g, " ").replace(/#\w+/g, " ").split("\n").map((l) => l.trim()).find(Boolean), 80) || "Shared track";
  const track = { eventId: event.id, pubkey: event.pubkey.toLowerCase(), kind: 1, d: "", createdAt: Number(event.created_at) || 0, url, title, artist: "", album: "", genre: "", description: "", duration: 0, coverArt: image, key: event.id, social: true };
  return toUnified(track);
}

// ── Zaps ───────────────────────────────────────────────────────────
const BOLT11 = /^ln(?:bc|tb|tbs|bcrt)(\d+)([munp]?)/i;
const MULTIPLIER = { "": 1, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 };
/** Sats paid by one kind 9735 zap receipt (from the invoice amount; 0 when it can't be read). */
export function zapSats(receipt) {
  const invoice = (receipt?.tags || []).find((t) => t?.[0] === "bolt11")?.[1];
  const m = BOLT11.exec(String(invoice || ""));
  if (!m) return 0;
  const sats = Number(m[1]) * MULTIPLIER[m[2].toLowerCase()] * 1e8;
  return Number.isFinite(sats) ? Math.floor(sats) : 0;
}

/** Map<trackKey, { count, sats }> from zap receipts that point at a track by `e` (event id) or `a` (coordinate) tag. */
export function countZaps(receipts, tracks) {
  const byId = new Map(); const byCoord = new Map();
  for (const t of tracks) { byId.set(t.eventId, t.key); if (isAddressableTrackKind(t.kind) && t.d) byCoord.set(`${t.kind}:${t.pubkey}:${t.d}`, t.key); }
  const out = new Map(); const seen = new Set();
  for (const r of receipts || []) {
    if (!r || r.kind !== 9735 || seen.has(r.id)) continue; seen.add(r.id);
    const key = (r.tags || []).map((t) => (t?.[0] === "e" ? byId.get(t[1]) : t?.[0] === "a" ? byCoord.get(t[1]) : null)).find(Boolean);
    if (!key) continue;
    const entry = out.get(key) || { count: 0, sats: 0 };
    entry.count += 1; entry.sats += zapSats(r); out.set(key, entry);
  }
  return out;
}

// ── Pool and sections ──────────────────────────────────────────────
/** Which tracks may headline Home: legacy kinds keep the strict "real song" filter, newer kinds only need a real title and playable audio. */
export function homePool(tracks) {
  return (tracks || []).filter((t) => {
    if (!t?.url || t.social) return false;
    if (t.kind !== TRACK_KIND) return isRealMusic(t);
    const { missing } = assessTrack(t);
    return !missing.includes("title") && !(t.duration && missing.includes("duration"));
  });
}

export function seededShuffle(list, seed = 1) {
  const out = [...list]; let a = (seed >>> 0) || 1;
  const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

export function greetingFor(date = new Date()) {
  const h = date.getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const newestFirst = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
const isMainKind = (t) => t.kind === AUDIO_HEADER_KIND || t.kind === TRACK_KIND;

/**
 * The six fixed carousels, in order. Every section has { id, title, type, tags, items, preview? }; `tags` drive the filter chips.
 * Sections with no items are returned too: the view decides between a skeleton (still loading) and omitting them.
 */
export function buildSections({ pool = [], albums = [], playlists = [], social = [], followSet = new Set(), zaps = new Map(), now = Math.floor(Date.now() / 1000), seed = 1 } = {}) {
  const main = pool.filter(isMainKind);
  const fromFollows = social.filter((t) => followSet.has(t.pubkey)).sort(newestFirst);
  const community = social.filter((t) => !followSet.has(t.pubkey)).sort(newestFirst);
  const followsItems = fromFollows.length || !community.length ? fromFollows : community;
  const albumsSorted = [...albums].sort((a, b) => (followSet.has(b.pubkey) - followSet.has(a.pubkey)) || newestFirst(a, b));
  const playlistsSorted = [...playlists].sort((a, b) => (b.refs.length - a.refs.length) || newestFirst(a, b));
  const zapped = main.filter((t) => zaps.has(t.key)).sort((a, b) => (zaps.get(b.key).sats - zaps.get(a.key).sats) || (zaps.get(b.key).count - zaps.get(a.key).count));
  const preview = !zapped.length;
  return [
    { id: "made-for-you", title: "Made For You", type: "track", tags: ["music", "foryou"], items: seededShuffle(main, seed) },
    { id: "follows", title: fromFollows.length || !community.length ? "From Your Follows" : "From The Community", type: "track", tags: ["music", "foryou"], items: followsItems },
    { id: "new", title: "New on Strify", type: "track", tags: ["music", "new"], items: main.filter((t) => t.createdAt >= now - HOME.newWindowSeconds).sort(newestFirst) },
    { id: "albums", title: "Albums For You", type: "album", tags: ["music", "foryou"], items: albumsSorted },
    { id: "playlists", title: "Popular Playlists", type: "playlist", tags: ["music"], items: playlistsSorted },
    { id: "zapped", title: "Zapped Most Today", type: "track", tags: ["music", "zaps"], items: preview ? seededShuffle(main, seed + 7).slice(0, 30) : zapped, preview },
  ];
}

/** Carousels revealed by the infinite scroll: artists, then genres, then artists' catalogs, then older tracks. Pure function of the pool. */
export function buildExtraSections({ pool = [], artists = [], profileOf = () => null, now = Math.floor(Date.now() / 1000), seed = 1 } = {}) {
  const main = pool.filter(isMainKind);
  const out = [];
  const counts = (pick) => { const m = new Map(); for (const t of main) { const k = pick(t); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };

  const byPubkey = new Map(artists.map((a) => [a.pubkey, a]));
  for (const [pubkey] of counts((t) => t.pubkey)) {
    if (byPubkey.size >= 24) break;
    if (byPubkey.has(pubkey)) continue;
    const latest = main.filter((t) => t.pubkey === pubkey).sort(newestFirst)[0];
    const profile = profileOf(pubkey);
    byPubkey.set(pubkey, { type: "artist", id: pubkey, key: `artist:${pubkey}`, pubkey, name: latest?.artist || profile?.name || "", imageUrl: safeHttpsUrl(profile?.picture) || latest?.coverArt || "", sourceKind: 0 });
  }
  const artistItems = [...byPubkey.values()].filter((a) => a.name).slice(0, 24);
  if (artistItems.length >= 3) out.push({ id: "artists", title: "Artists To Explore", type: "artist", tags: ["music"], items: seededShuffle(artistItems, seed + 3) });

  for (const [genre] of counts((t) => t.genre).filter(([, n]) => n >= 3).slice(0, 6)) {
    out.push({ id: `genre-${genre.toLowerCase()}`, title: `Top in ${genre}`, type: "track", tags: ["music"], items: seededShuffle(main.filter((t) => t.genre === genre), seed + genre.length) });
  }
  for (const [pubkey] of counts((t) => t.pubkey).filter(([, n]) => n >= 3).slice(0, 6)) {
    const items = main.filter((t) => t.pubkey === pubkey).sort(newestFirst);
    out.push({ id: `more-${pubkey.slice(0, 12)}`, title: `More from ${items[0].artist || profileOf(pubkey)?.name || "this artist"}`, type: "track", tags: ["music"], items });
  }
  const older = main.filter((t) => t.createdAt < now - HOME.newWindowSeconds);
  if (older.length >= 4) out.push({ id: "gems", title: "Hidden Gems", type: "track", tags: ["music"], items: seededShuffle(older, seed + 11) });
  return out.filter((s) => s.items.length);
}
