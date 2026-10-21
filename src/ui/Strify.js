// strify UI: /strify page, persistent mini-player, playlist management, shared-playlist previews, track social actions.
// All Nostr I/O goes through the host (main.js) for signing/publishing/zaps, and StrifyNet for reads.
import { escapeHtml, shorten, timeAgo } from "../core/format.js";
import { npubFromHex } from "../core/nostr-core.js";
import { navigate } from "../core/router.js";
import { ensureNostrTools } from "../core/auth.js";
import { StrifyNet } from "../core/strify-net.js";
import * as player from "../core/strify-player.js";
import { AUDIO_HEADER_KIND, AUDIO_TRACK_KIND, PLAYLIST_KIND, DELETION_KIND, DISCOVERY, FEED_KINDS, REPOST_KIND, COMMENT_KIND, UPLOAD, GENRES, LICENSES, LIBRARY, QUALITY, limitsFor } from "../core/strify-config.js";
import { playlistCoordinateFromTags } from "../core/strify-embed.js";
import { resolveFollows } from "../core/strify-follows.js";
import { resolveAudioEvents, trackRef, safeHttpsUrl, classifyMediaUrl, parseAudioEvent, dedupeTracks } from "../core/strify-tracks.js";
import { parseArtistParam, artistPath, artistFilter, mergeArtistPage, oldestCreatedAt, hasMorePages, artistTracksOnly } from "../core/strify-artist.js";
import { STATUS_KIND, STATUS_D, buildStatusTemplate, buildClearStatusTemplate, liveStatuses } from "../core/strify-status.js";
import { filterTracks, profileSearchNames, normalizeQuery, followsDiffer } from "../core/strify-feeds.js";
import { assessTrack, isRealMusic, filterRealMusic } from "../core/strify-quality.js";
import { createHistory } from "../core/strify-history.js";
import { recommend, topGenres } from "../core/strify-reco.js";
import { validateAudioFile, validateCoverFile, validateDetails, buildTrackTemplate, buildEditedTemplate, licenseOfEvent, uploadFile, serversFromEvent, formatBytes } from "../core/strify-upload.js";
import { checkCopyright } from "../core/strify-copyright.js";
import { PlaylistStore, fetchPlaylistVersion, refKey, playlistCoordinate, checkCreate, checkAddTrack } from "../core/strify-playlists.js";
import { formatDuration } from "../core/music.js";
import { pauseProfileMusic, setProfileAutoplayBlocker, setProfilePlayHook } from "../core/profile-player.js";

const net = new StrifyNet();
const HEX64 = /^[0-9a-f]{64}$/i;
let host = null;
let pageActive = false;
let pageToken = 0;

const S = {
  mine: { status: "idle", tracks: [], pubkey: "", loadedAt: 0 }, // signed-in user's own kind 1808 tracks, loaded before the rest
  tab: "home", libTab: "playlists", view: null, artist: null, // tab: home | search | library | create; artist = hex pubkey while the discography view is open (?artist=…)
  likes: { status: "idle", tracks: [], pubkey: "", loadedAt: 0 }, // the signed-in user's kind 7 likes on tracks, resolved to tracks
  create: { busy: false, audio: null, cover: null, duration: 0, coverUrl: "", check: null, checkKey: "", uploaded: new Map(), dirtyRender: false },
  global: { status: "idle", tracks: [], skipped: 0, error: "", loadedAt: 0 },
  forYou: { status: "idle", tracks: [], error: "", follows: 0, followSet: new Set(), followState: "none", pubkey: "", loadedAt: 0 },
  query: "",
  viewMode: readViewMode(), // "card" (default) | "list"; a UI preference cached in localStorage only
};
function readViewMode() { try { return localStorage.getItem("strify:view-mode") === "list" ? "list" : "card"; } catch { return "card"; } }
function saveViewMode(mode) { try { localStorage.setItem("strify:view-mode", mode); } catch { /* preference is optional */ } }
let store = null;
let storeUnsub = null;
const tracksByKey = new Map();   // track key -> track (everything we've seen)
const rawEvents = new Map();      // event id -> raw event (for reposts)
const profiles = new Map();       // pubkey -> { name, picture }
const refCache = new Map();       // refKey -> track | null
const embedCache = new Map();     // playlist coordinate -> { state, playlist, tracks, at }
const liked = new Set();
const history = createHistory();
const catalog = () => dedupeTracks([...S.mine.tracks, ...S.forYou.tracks, ...S.global.tracks]);
const myPubkey = () => host.getSession()?.pubkeyHex || "";
const onPlaylists = () => S.tab === "library" && S.libTab === "playlists";
const artists = new Map();        // pubkey -> { status, tracks, until, exhausted, loadingMore, error, skipped, loadedAt }

const icon = (name, extra = "") => `<i class="fa-solid ${name}${extra ? ` ${extra}` : ""}" aria-hidden="true"></i>`;
const E = escapeHtml;
const userRelays = () => host.getUserRelays();
// Reads go to the relays the user marked "read" in the Relays settings.
const musicAndUserRelays = () => userRelays();
const fetchEventsFrom = (urls) => (filters) => net.fetch(filters, { urls, timeout: DISCOVERY.fetchTimeout });

function register(track) {
  if (!track?.key) return;
  const prior = tracksByKey.get(track.key);
  if (!prior || track.createdAt >= prior.createdAt) tracksByKey.set(track.key, track);
}
function artistOf(track) { return track.artist || profiles.get(track.pubkey)?.name || shorten(npubFromHex(track.pubkey), 8, 4); }

// ── Cover art (lazy, with a graceful placeholder) ──────────────────
function coverHtml(url, alt = "") {
  const img = url ? `<img src="${E(url)}" alt="${E(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-strify-cover>` : "";
  return `<span class="strify-cover${url ? "" : " is-empty"}">${img}<span class="strify-cover-fallback" aria-hidden="true">${icon("fa-music")}</span></span>`;
}
document.addEventListener("error", (event) => {
  const img = event.target;
  if (img instanceof HTMLImageElement && img.hasAttribute("data-strify-cover")) { img.closest(".strify-cover")?.classList.add("is-empty"); img.remove(); }
}, true);

// ── Discovery ──────────────────────────────────────────────────────
async function discover(filters, urls) {
  const events = await net.fetch(filters, { urls, timeout: DISCOVERY.fetchTimeout });
  events.forEach((e) => rawEvents.set(e.id, e));
  const { tracks, skipped } = await resolveAudioEvents(events, { fetchEvents: fetchEventsFrom(urls) });
  tracks.forEach(register);
  return { tracks, skipped, scanned: events.length, events };
}

// Your own kind 1808 tracks come first: a dedicated query by your pubkey (so they never fall outside the
// "latest N events" scan of everyone else), shown at the top before the rest of the music is scanned.
async function loadMine(force = false, deep = false) {
  const me = host.getSession()?.pubkeyHex || "";
  const m = S.mine;
  if (m.pubkey !== me) Object.assign(m, { status: "idle", tracks: [], pubkey: me, loadedAt: 0, scan: null });
  if (!me || m.status === "loading" || (!force && !deep && m.status === "ready" && Date.now() - m.loadedAt < 300_000)) return;
  m.status = "loading";
  try {
    let urls = userRelays();
    if (deep) {
      // Also ask the relays this account lists in its own relay list (kind 10002, NIP-65): songs are often only on those.
      try {
        const list = (await net.fetch([{ kinds: [10002], authors: [me], limit: 3 }], { urls: urls.slice(0, 4), timeout: 4000 })).sort((a, b) => b.created_at - a.created_at)[0];
        const extra = (list?.tags || []).filter((t) => t?.[0] === "r" && /^wss:\/\//i.test(t[1] || "") && t[2] !== "read").map((t) => t[1]).slice(0, 8);
        urls = [...new Set([...urls, ...extra])];
      } catch { /* the configured relays still get searched */ }
    }
    // Page backwards: relays often return fewer events than asked for, so one query can miss older songs.
    const seen = new Map(); const found = []; let until = null; let pages = 0;
    for (; pages < (deep ? 20 : 8); pages++) {
      let result;
      try { result = await discover([artistFilter(me, { limit: DISCOVERY.perKindLimit, until })], urls); }
      catch (error) { if (!pages) throw error; break; }
      const fresh = result.events.filter((e) => !seen.has(e.id));
      fresh.forEach((e) => seen.set(e.id, e)); found.push(...result.tracks);
      const oldest = oldestCreatedAt(result.events, me);
      if (!fresh.length || oldest === null || (until !== null && oldest > until)) { pages++; break; }
      until = oldest;
    }
    if (S.mine.pubkey !== me) return; // signed out or switched account while loading
    const tracks = artistTracksOnly(found, me);
    const playable = new Set(tracks.map((t) => t.eventId));
    const hidden = [...seen.values()].filter((e) => e.pubkey === me && e.kind === AUDIO_HEADER_KIND && !playable.has(e.id));
    const titles = hidden.slice(0, 6).map((e) => { try { return String(JSON.parse(e.content || "{}").title || "").slice(0, 60) || "Untitled"; } catch { return "Untitled"; } });
    Object.assign(m, { status: "ready", tracks, loadedAt: Date.now(), scan: { events: seen.size, playable: tracks.length, hidden: hidden.length, titles, relays: urls.length, pages, deep } });
    if (deep) host.toast(`Found ${tracks.length} song${tracks.length === 1 ? "" : "s"} across ${urls.length} relay${urls.length === 1 ? "" : "s"}.`);
  } catch { if (S.mine.pubkey === me) m.status = "error"; } // the rest of strify still loads
  if (pageActive) paintBody();
}

// Home/Search need the whole catalog (yours first, then follows, then everyone); Library and Create only need your own data.
async function startDiscovery(tab = S.tab, force = false) {
  syncSessionStore();
  if (tab === "create") { void loadMine(force); return; }
  if (tab === "library") { await Promise.all([loadMine(force), loadLikes(force), loadPlaylists()]); return; }
  await loadMine(force);
  if (!pageActive || S.artist) return;
  // The follow list can change while strify is open (follow/unfollow elsewhere): rebuild the follows pool when it does.
  const account = myPubkey();
  const known = account ? host.getFollows?.(account) : [];
  const stale = S.forYou.status === "ready" && (S.forYou.pubkey !== account || (known?.length && followsDiffer(S.forYou.followSet, known)));
  const jobs = [loadForYou(force || stale), loadGlobal(force)];
  if (tab === "home") jobs.push(loadLikes(force));
  await Promise.all(jobs);
}

// Likes are kind 7 reactions this account published on tracks. They are read back so "Liked songs" survives reloads and devices.
async function loadLikes(force = false) {
  const account = myPubkey();
  const l = S.likes;
  if (l.pubkey !== account) Object.assign(l, { status: "idle", tracks: [], pubkey: account, loadedAt: 0 });
  if (!account || l.status === "loading" || (!force && l.status === "ready" && Date.now() - l.loadedAt < 300_000)) return;
  l.status = "loading";
  try {
    const events = await net.fetch([{ kinds: [7], authors: [account], "#k": [String(AUDIO_HEADER_KIND), String(AUDIO_TRACK_KIND)], limit: LIBRARY.likesLimit }], { urls: userRelays(), timeout: DISCOVERY.fetchTimeout });
    const likedAt = new Map();
    for (const event of events) {
      if (event.pubkey !== account || event.kind !== 7 || event.content === "-") continue;
      const id = event.tags?.find((t) => t[0] === "e" && HEX64.test(t[1] || ""))?.[1]?.toLowerCase();
      if (id) likedAt.set(id, Math.max(likedAt.get(id) || 0, event.created_at));
    }
    likedAt.forEach((_, id) => liked.add(id));
    const have = new Map();
    for (const track of tracksByKey.values()) if (likedAt.has(track.eventId)) have.set(track.eventId, track);
    const missing = [...likedAt.keys()].filter((id) => !have.has(id));
    for (let i = 0; i < missing.length; i += 50) {
      const result = await discover([{ ids: missing.slice(i, i + 50) }], userRelays());
      result.tracks.forEach((track) => have.set(track.eventId, track));
    }
    if (S.likes.pubkey !== account) return;
    const tracks = [...likedAt.keys()].map((id) => have.get(id)).filter(Boolean).sort((a, b) => likedAt.get(b.eventId) - likedAt.get(a.eventId));
    Object.assign(l, { status: "ready", tracks, loadedAt: Date.now() });
  } catch { if (S.likes.pubkey === account) l.status = "error"; }
  if (pageActive) { paintBody(); void loadArtistProfiles(S.likes.tracks); }
}

async function loadGlobal(force = false) {
  const g = S.global;
  if (g.status === "loading" || (!force && g.status === "ready" && Date.now() - g.loadedAt < 300_000)) return;
  g.status = "loading"; g.error = ""; paintBody();
  try {
    // Everyone's kind 1808 events on the configured relays — deliberately not limited to follows.
    const result = await discover([{ kinds: [...FEED_KINDS], limit: DISCOVERY.perKindLimit }], userRelays());
    Object.assign(g, { status: "ready", tracks: result.tracks, skipped: result.skipped, scanned: result.scanned, loadedAt: Date.now() });
  } catch (error) { g.status = "error"; g.error = error?.message || "Couldn't load music."; }
  if (pageActive) { paintBody(); void loadArtistProfiles(g.tracks); }
}

async function loadForYou(force = false) {
  const f = S.forYou;
  const me = host.getSession()?.pubkeyHex || "";
  if (f.pubkey !== me) Object.assign(f, { status: "idle", tracks: [], follows: 0, followSet: new Set(), followState: "none", pubkey: me, loadedAt: 0 }); // account switched
  if (f.status === "loading" || (!force && f.status === "ready" && Date.now() - f.loadedAt < 300_000)) return;
  f.status = "loading"; f.error = ""; paintBody();
  try {
    let follows = [];
    f.followState = "none";
    if (me) {
      // Use the follow list the app already loaded; only ask relays (all configured ones) if it's missing.
      const resolved = await resolveFollows({
        me, known: host.getFollows?.(me),
        fetchEvents: (filters) => net.fetch(filters, { urls: userRelays(), timeout: 5000 }),
      });
      follows = resolved.follows; f.followState = resolved.state;
    }
    if (f.pubkey !== me) return; // signed out / switched account mid-load
    f.follows = follows.length;
    f.followSet = new Set(follows);
    let tracks = [];
    if (me) {
      // Author-restricted query: the user's own pubkey plus follows, so nothing from strangers is even fetched.
      const authors = [me, ...follows.filter((pk) => pk !== me)].slice(0, 300);
      const result = await discover([{ kinds: [...FEED_KINDS], authors, limit: 150 }], musicAndUserRelays());
      tracks = result.tracks;
    }
    if (f.pubkey !== me) return;
    Object.assign(f, { status: "ready", tracks, loadedAt: Date.now() });
  } catch (error) { f.status = "error"; f.error = error?.message || "Couldn't load music from your follows."; }
  if (pageActive) { paintBody(); void loadArtistProfiles(f.tracks); }
}

// ── Artist discography (kind 1808 by one pubkey) ───────────────────
const artistState = (pubkey) => {
  if (!artists.has(pubkey)) artists.set(pubkey, { status: "idle", tracks: [], until: null, exhausted: false, loadingMore: false, error: "", moreError: "", skipped: 0, loadedAt: 0 });
  return artists.get(pubkey);
};
function artistName(pubkey) {
  return profiles.get(pubkey)?.name || artists.get(pubkey)?.tracks.find((t) => t.artist)?.artist || shorten(npubFromHex(pubkey), 8, 4);
}

async function loadArtist(pubkey, { more = false, force = false } = {}) {
  const a = artistState(pubkey);
  if (more) { if (a.loadingMore || a.exhausted || a.status !== "ready") return; }
  else if (a.status === "loading" || (!force && a.status === "ready" && Date.now() - a.loadedAt < 300_000)) return;
  if (more) { a.loadingMore = true; a.moreError = ""; }
  else Object.assign(a, { status: "loading", tracks: [], until: null, exhausted: false, error: "", moreError: "", skipped: 0 });
  paintBody();
  try {
    const result = await discover([artistFilter(pubkey, { until: more ? a.until : null })], userRelays());
    const { tracks, added } = mergeArtistPage(more ? a.tracks : [], result.tracks, pubkey);
    const oldest = oldestCreatedAt(result.events, pubkey);
    const cursorMoved = oldest !== null && (a.until === null || oldest <= a.until);
    a.tracks = tracks;
    a.skipped = more ? a.skipped + result.skipped : result.skipped;
    a.until = oldest ?? a.until;
    a.exhausted = !hasMorePages({ scanned: result.scanned, added, cursorMoved });
    Object.assign(a, { status: "ready", loadedAt: Date.now(), error: "" });
  } catch (error) {
    const message = error?.message || "Couldn't load this artist's music.";
    if (more) a.moreError = message; else Object.assign(a, { status: "error", error: message });
  }
  a.loadingMore = false;
  if (pageActive && S.artist === pubkey) paintBody();
}

function artistRow(track, index) {
  const current = player.currentTrack();
  const meta = [track.genre, track.duration ? formatDuration(track.duration) : ""].filter(Boolean).join(" · ");
  return `<li class="strify-row strify-artist-row${current?.key === track.key ? " is-current" : ""}" data-strify-card="${E(track.key)}">
    <button type="button" class="strify-row-main" data-strify-play-from="artist" data-index="${index}" aria-label="Play ${E(track.title)}">
      <span class="strify-row-index" aria-hidden="true">${index + 1}</span>${coverHtml(track.coverArt)}<span class="strify-row-text"><strong>${E(track.title)}</strong>${meta ? `<small>${E(meta)}</small>` : ""}</span>
    </button>
    <span class="strify-row-actions"><button type="button" data-strify-addto="${E(track.key)}" aria-label="Add ${E(track.title)} to a playlist" title="Add to playlist">${icon("fa-circle-plus")}</button></span>
  </li>`;
}

function artistHtml() {
  const pubkey = S.artist;
  const a = artistState(pubkey);
  const name = artistName(pubkey);
  const picture = safeHttpsUrl(profiles.get(pubkey)?.picture);
  const count = a.tracks.length;
  const sub = a.status === "ready" ? `${count} track${count === 1 ? "" : "s"}${a.exhausted ? "" : " loaded so far"}` : "";
  lists.artist = a.tracks;
  const head = `<button type="button" class="strify-link strify-back" data-strify-artist-back>${icon("fa-chevron-left")} Back to strify</button>
    <div class="strify-detail-head strify-artist-head">
      <span class="strify-artist-avatar">${picture ? `<img src="${E(picture)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-strify-cover>` : ""}<span class="strify-cover-fallback" aria-hidden="true">${icon("fa-user")}</span></span>
      <div><p class="strify-eyebrow">Artist</p><h2>${E(name)}</h2>${sub ? `<p class="strify-note">${E(sub)}</p>` : ""}<a class="strify-link" href="https://njump.me/${E(npubFromHex(pubkey))}" target="_blank" rel="noopener noreferrer">${icon("fa-user")} View Nostr profile</a></div>
    </div>`;
  let body;
  if (a.status === "idle" || a.status === "loading") body = stateBlock("loading", "Loading music…", `Looking for kind 1808 tracks published by ${name}.`);
  else if (a.status === "error") body = stateBlock("error", "Couldn't load this artist's music", a.error, `<button type="button" class="strify-btn" data-strify-artist-retry>${icon("fa-rotate-right")} Try again</button>`);
  else if (!count) body = stateBlock("empty", "No playable tracks found", `${name} hasn't published a playable kind 1808 track on your ${userRelays().length} configured relay${userRelays().length === 1 ? "" : "s"}${a.skipped ? ` (${a.skipped} had no usable audio URL)` : ""}. You can add more from the Relays button.`, `<button type="button" class="strify-btn" data-strify-artist-retry>${icon("fa-rotate-right")} Try again</button>`);
  else {
    body = `<div class="strify-toolbar"><button type="button" class="strify-btn is-primary" data-strify-play-from="artist" data-index="0">${icon("fa-play")} Play</button></div>
      <ol class="strify-rows">${a.tracks.map(artistRow).join("")}</ol>
      ${a.moreError ? `<p class="strify-banner" role="alert">${icon("fa-triangle-exclamation")} ${E(a.moreError)}</p>` : ""}
      ${a.exhausted ? "" : `<div class="strify-toolbar"><button type="button" class="strify-btn" data-strify-artist-more ${a.loadingMore ? "disabled" : ""}>${a.loadingMore ? `${icon("fa-circle-notch fa-spin")} Loading…` : `${icon("fa-clock-rotate-left")} Load older tracks`}</button></div>`}`;
  }
  return `${head}${body}`;
}

async function loadArtistProfiles(tracks) {
  const missing = [...new Set(tracks.map((t) => t.pubkey))].filter((pk) => !profiles.has(pk)).slice(0, 80);
  if (!missing.length) return;
  missing.forEach((pk) => profiles.set(pk, {}));
  try {
    const events = await net.fetch([{ kinds: [0], authors: missing, limit: missing.length }], { urls: musicAndUserRelays(), timeout: 4000 });
    for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
      try { const p = JSON.parse(event.content); profiles.set(event.pubkey, { ...p, name: String(p.display_name || p.name || "").slice(0, 60) }); } catch { /* skip bad profile */ }
    }
    if (pageActive) paintBody();
  } catch { /* names fall back to short npubs */ }
}

// ── Branding ───────────────────────────────────────────────────────
// Same visual language as the friendstr mark: rounded ring "nodes" joined by rounded strokes, here forming a music note.
export function strifyMark(className = "strify-mark") {
  return `<svg class="${className}" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="strify" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9.5" cy="23" r="4.6"/><path d="M14.2 22.2 V7.5"/><path d="M14.2 8.6 20.4 11.2"/><circle cx="24.4" cy="13.2" r="3.2"/></svg>`;
}

// ── Page markup ────────────────────────────────────────────────────
const NAV = [["home", "Home", "fa-house"], ["search", "Search", "fa-magnifying-glass"], ["library", "My Library", "fa-book-open"], ["create", "Create", "fa-cloud-arrow-up"]];
export function renderStrifyPage() {
  return `<section class="strify-page" aria-label="strify music">
    <header class="strify-hero">
      <div class="strify-brand">${strifyMark("strify-mark")}<div><h1 class="strify-wordmark" aria-label="strify"><span class="strify-wm-a">str</span>ify</h1><p class="strify-tagline"><small>Nostr music</small></p></div></div>
      <nav class="strify-tabs" role="tablist" aria-label="strify sections">
        ${NAV.map(([id, label, ic]) => `<button type="button" role="tab" class="strify-tab" data-strify-tab="${id}" aria-selected="${!parseArtistParam(window.location.search) && S.tab === id}">${icon(ic)}<span>${label}</span></button>`).join("")}
      </nav>
      <button type="button" class="strify-share-toggle" data-strify-share-status aria-pressed="false" title="Publishes a public Nostr status (NIP-38) while you play. Friends see a ring around your avatar. Off by default."><i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i><span>Share what I play</span></button>
    </header>
    <div class="strify-feedbar" data-strify-feedbar>
      <div class="strify-search" data-strify-search-wrap role="search">
        ${icon("fa-magnifying-glass")}
        <input type="search" data-strify-search class="strify-search-input" placeholder="Search songs, artists, or genres..." aria-label="Search songs, artists, or genres" autocomplete="off" spellcheck="false" value="${E(S.query)}">
        <button type="button" class="strify-search-clear" data-strify-search-clear aria-label="Clear search" ${S.query ? "" : "hidden"}>${icon("fa-xmark")}</button>
      </div>
      <div class="strify-viewtoggle" role="group" aria-label="Layout">
        <button type="button" data-strify-view="card" aria-pressed="${S.viewMode === "card"}" aria-label="Card view" title="Card view">${icon("fa-table-cells-large")}</button>
        <button type="button" data-strify-view="list" aria-pressed="${S.viewMode === "list"}" aria-label="List view" title="List view">${icon("fa-list")}</button>
      </div>
    </div>
    <div class="strify-fullplayer" data-strify-fullplayer hidden></div>
    <div id="strifyBody" class="strify-body" aria-live="polite"></div>
  </section>`;
}

export function startStrifyPage() {
  pageActive = true; pageToken++;
  S.artist = parseArtistParam(window.location.search);
  syncSessionStore();
  paintBody();
  if (S.artist) { void loadArtist(S.artist); void loadArtistProfiles([{ pubkey: S.artist }]); }
  else void startDiscovery();
  syncUi();
}
export function stopStrifyPage() { if (pageActive) { pageActive = false; pageToken++; } }

function stateBlock(kind, title, text, action = "") {
  return `<div class="strify-state strify-state-${kind}" role="${kind === "error" ? "alert" : "status"}">${icon(kind === "loading" ? "fa-circle-notch fa-spin" : kind === "error" ? "fa-triangle-exclamation" : "fa-compact-disc")}<strong>${E(title)}</strong>${text ? `<p>${E(text)}</p>` : ""}${action}</div>`;
}
const skeleton = () => `<div class="strify-grid" aria-hidden="true">${Array.from({ length: 8 }, () => `<div class="strify-card is-skeleton"><span class="strify-cover is-empty"></span><i></i><i></i></div>`).join("")}</div>`;

const canDelete = (track) => S.tab === "library" && S.libTab === "uploads" && track.kind === AUDIO_HEADER_KIND && track.pubkey === myPubkey();
function incompleteNote(track) {
  if (!(S.tab === "library" && S.libTab === "uploads")) return "";
  const { ok, missing } = assessTrack(track);
  return ok ? "" : `<small class="strify-warn" title="Home only shows songs with a title, artist, cover, genre and duration">${icon("fa-eye-slash")} Hidden from Home: ${E(missing.join(", "))}</small>`;
}
function trackCard(track, listName, index) {
  const current = player.currentTrack();
  return `<article class="strify-card${current?.key === track.key ? " is-current" : ""}" data-strify-card="${E(track.key)}">
    <button type="button" class="strify-card-art" data-strify-play-from="${E(listName)}" data-index="${index}" aria-label="Play ${E(track.title)} by ${E(artistOf(track))}">
      ${coverHtml(track.coverArt, "")}<span class="strify-card-play">${icon("fa-play")}</span>
    </button>
    <div class="strify-card-meta"><strong title="${E(track.title)}">${E(track.title)}</strong><span title="${E(artistOf(track))}">${E(artistOf(track))}</span>${incompleteNote(track)}</div>
    <div class="strify-card-actions" role="group" aria-label="Actions for ${E(track.title)}">
      ${actionButtons(track)}
    </div>
  </article>`;
}
function likeButton(track) {
  const on = liked.has(track.eventId);
  return `<button type="button" data-strify-like="${E(track.key)}" aria-label="Like" aria-pressed="${on}" class="${on ? "is-active" : ""}" title="Like">${icon("fa-heart")}</button>`;
}
function deleteButton(track) {
  return canDelete(track) ? `<button type="button" data-strify-delete-track="${E(track.key)}" aria-label="Remove ${E(track.title)}" title="Remove from Nostr">${icon("fa-trash")}</button>` : "";
}
function editButton(track) {
  return canDelete(track) && track.url ? `<button type="button" data-strify-edit-track="${E(track.key)}" aria-label="Edit ${E(track.title)}" title="Edit song info">${icon("fa-pen")}</button>` : "";
}
function actionButtons(track) {
  const k = E(track.key);
  return `${likeButton(track)}
    <button type="button" data-strify-zap="${k}" aria-label="Zap" title="Zap">${icon("fa-bolt")}</button>
    <button type="button" data-strify-repost="${k}" aria-label="Repost" title="Repost">${icon("fa-retweet")}</button>
    <button type="button" data-strify-comment="${k}" aria-label="Comment" title="Comment">${icon("fa-comment")}</button>
    <button type="button" data-strify-addto="${k}" aria-label="Add to playlist" title="Add to playlist">${icon("fa-circle-plus")}</button>${editButton(track)}${deleteButton(track)}`;
}

const lists = {};
const listLabels = {};
const labelFor = (name) => listLabels[name] || (name === "artist" && S.artist ? artistName(S.artist) : "strify");
// One renderer for every track list; card vs list is purely presentation over the same data and play queue.
function grid(listName, tracks, label = "") {
  lists[listName] = tracks;
  if (label) listLabels[listName] = label;
  if (S.viewMode === "list") return `<div class="strify-list" role="list">${tracks.map((t, i) => trackRow(t, listName, i)).join("")}</div>`;
  return `<div class="strify-grid">${tracks.map((t, i) => trackCard(t, listName, i)).join("")}</div>`;
}
function trackRow(track, listName, index) {
  const current = player.currentTrack();
  const k = E(track.key);
  return `<article class="strify-lrow${current?.key === track.key ? " is-current" : ""}" role="listitem" data-strify-card="${k}">
    <button type="button" class="strify-lrow-art" data-strify-play-from="${E(listName)}" data-index="${index}" aria-label="Play ${E(track.title)} by ${E(artistOf(track))}">${coverHtml(track.coverArt, "")}<span class="strify-lrow-play">${icon("fa-play")}</span></button>
    <div class="strify-lrow-text"><strong title="${E(track.title)}">${E(track.title)}</strong><span title="${E(artistOf(track))}">${E(artistOf(track))}</span></div>
    ${incompleteNote(track) ? `<span class="strify-lrow-genre">${incompleteNote(track)}</span>` : track.genre ? `<span class="strify-lrow-genre" title="Genre">${E(track.genre)}</span>` : ""}
    ${track.duration ? `<span class="strify-lrow-dur">${formatDuration(track.duration)}</span>` : ""}
    <div class="strify-lrow-actions" role="group" aria-label="Actions for ${E(track.title)}">
      ${likeButton(track)}
      <button type="button" data-strify-zap="${k}" aria-label="Zap" title="Zap">${icon("fa-bolt")}</button>
      <button type="button" data-strify-addto="${k}" aria-label="Add to playlist" title="Add to playlist">${icon("fa-circle-plus")}</button>${editButton(track)}${deleteButton(track)}
    </div>
  </article>`;
}

const namesFor = (pubkey) => profileSearchNames(profiles.get(pubkey));

// ── Views: Home · Search · My Library · Create ─────────────────────
const loadingCatalog = () => ["idle", "loading"].includes(S.global.status) || S.forYou.status === "loading" || S.mine.status === "loading";
const retryButton = (tab) => `<button type="button" class="strify-btn" data-strify-retry="${tab}">${icon("fa-rotate-right")} Try again</button>`;
const signInBlock = (title, text) => stateBlock("empty", title, text, `<button type="button" class="strify-btn" data-strify-signin>${icon("fa-arrow-right-to-bracket")} Sign in</button>`);

/** A horizontally scrolling shelf of cards. Playing a card queues the whole shelf. */
function shelf(id, title, iconName, tracks, action = "") {
  if (!tracks.length) return "";
  lists[id] = tracks; listLabels[id] = title;
  return `<section class="strify-shelf-sec" aria-label="${E(title)}">
    <div class="strify-shelf-head"><h2>${icon(iconName)} ${E(title)}</h2>${action}</div>
    <div class="strify-shelf" role="list">${tracks.map((track, i) => `<div class="strify-shelf-item" role="listitem">${trackCard(track, id, i)}</div>`).join("")}</div>
  </section>`;
}

function recentTracks() {
  const recent = history.list(myPubkey());
  recent.forEach(register);
  return recent.map((track) => tracksByKey.get(track.key) || track);
}

function homeHtml() {
  const account = myPubkey();
  const all = catalog();
  const real = filterRealMusic(all);
  const likedReal = filterRealMusic(S.likes.tracks);
  const played = filterRealMusic(recentTracks());
  const size = LIBRARY.shelfSize;
  const sections = [
    account ? shelf("home-liked", "Liked songs", "fa-heart", likedReal.slice(0, size), likedReal.length > size ? `<button type="button" class="strify-link" data-strify-goto-lib="liked">View all</button>` : "") : "",
    shelf("home-recent", "Recently played", "fa-clock-rotate-left", played.slice(0, size), `<button type="button" class="strify-link" data-strify-recent-clear>Clear</button>`),
    shelf("home-new", "New releases", "fa-compact-disc", real.slice(0, size)),
  ].join("");
  const hidden = all.length - real.length;
  const loading = loadingCatalog();
  if (!sections) {
    if (loading) return skeleton();
    if (S.global.status === "error" && !all.length) return stateBlock("error", "Couldn't reach the music relays", S.global.error, retryButton("home"));
    return stateBlock("empty", "No complete songs found yet", `Home only lists songs that have a title, artist, cover, genre and duration.${hidden ? ` ${hidden} track${hidden === 1 ? " was" : "s were"} hidden because their info is incomplete; Search can still find ${hidden === 1 ? "it" : "them"}.` : ""}`, `<button type="button" class="strify-btn is-primary" data-strify-goto="create">${icon("fa-cloud-arrow-up")} Upload a song</button> <button type="button" class="strify-btn" data-strify-goto="search">${icon("fa-magnifying-glass")} Search</button>`);
  }
  const intro = account ? "" : `<p class="strify-note">${icon("fa-circle-info")} Sign in to see your liked songs and to upload your own music.</p>`;
  const note = hidden && !loading ? `<p class="strify-note">${hidden} track${hidden === 1 ? "" : "s"} hidden: Home only lists songs with a title, artist, cover, genre and duration. You can still find ${hidden === 1 ? "it" : "them"} in Search.</p>` : "";
  return `${intro}${sections}${loading ? skeleton() : ""}${note}`;
}

const RECO_ICONS = { "more-artist": "fa-user", "because-genre": "fa-wand-magic-sparkles", follows: "fa-user-group", fresh: "fa-seedling" };
function searchHtml() {
  const all = catalog();
  const q = normalizeQuery(S.query);
  const loading = loadingCatalog();
  if (q) {
    const found = filterTracks(all, S.query, namesFor);
    const ordered = [...found.filter(isRealMusic), ...found.filter((t) => !isRealMusic(t))]; // complete songs first
    const note = `<p class="strify-note" role="status">${ordered.length} result${ordered.length === 1 ? "" : "s"} for “${E(S.query.trim())}”${loading ? " (still loading…)" : ""}. Search covers the music loaded from your relays.</p>`;
    if (!ordered.length) return `${note}${loading ? skeleton() : stateBlock("empty", "No matching music", `Nothing matches “${S.query.trim()}”. Check the spelling or try an artist or genre.`, `<button type="button" class="strify-btn" data-strify-search-clear>${icon("fa-xmark")} Clear search</button>`)}`;
    return `${note}${grid("search", ordered, "Search results")}${loading ? skeleton() : ""}`;
  }
  if (!all.length) {
    if (loading) return skeleton();
    if (S.global.status === "error") return stateBlock("error", "Couldn't reach the music relays", S.global.error, retryButton("search"));
    return stateBlock("empty", "No playable tracks found", `Searched your ${userRelays().length} configured relays. Relays can be offline or hold few audio events; you can add more from the Relays button.`, retryButton("search"));
  }
  const account = myPubkey();
  const genres = topGenres(filterRealMusic(all), 10);
  const chips = genres.length ? `<div class="strify-chips" role="group" aria-label="Browse by genre">${genres.map((g) => `<button type="button" class="strify-chip" data-strify-genre="${E(g.genre)}">${E(g.genre)}</button>`).join("")}</div>` : "";
  const sections = recommend({ catalog: all, recent: recentTracks(), liked: S.likes.tracks, follows: S.forYou.followSet, me: account });
  const shelves = sections.map((section) => shelf(`reco-${section.id}`, section.title, RECO_ICONS[section.id] || "fa-compact-disc", section.tracks)).join("");
  return `<p class="strify-note">Search songs, artists or genres above, or start from what's recommended.</p>${chips}${shelves || stateBlock("empty", "Nothing to recommend yet", "Play or like a few songs and recommendations will show up here.")}${loading ? skeleton() : ""}`;
}

// ── My Library ─────────────────────────────────────────────────────
function libraryHtml() {
  if (!host.getSession()) return signInBlock("Sign in to open your library", "Your playlists, uploads and liked songs live on your Nostr account.");
  const detail = S.libTab === "playlists" && S.view && store?.get(S.view);
  if (detail) return playlistDetailHtml(detail);
  const tabs = [["playlists", "Playlists", "fa-rectangle-list", store?.playlists.length], ["uploads", "Uploads", "fa-cloud-arrow-up", S.mine.tracks.length], ["liked", "Liked", "fa-heart", S.likes.tracks.length]];
  const seg = `<div class="strify-seg" role="tablist" aria-label="Library sections">${tabs.map(([id, label, ic, count]) => `<button type="button" role="tab" data-strify-lib="${id}" aria-selected="${S.libTab === id}">${icon(ic)}<span>${label}${count ? ` <em>${count}</em>` : ""}</span></button>`).join("")}</div>`;
  return `${seg}${S.libTab === "uploads" ? uploadsHtml() : S.libTab === "liked" ? likedHtml() : playlistsHtml()}`;
}

function uploadsHtml() {
  const mine = S.mine.tracks;
  const head = `<div class="strify-toolbar"><button type="button" class="strify-btn is-primary" data-strify-goto="create">${icon("fa-cloud-arrow-up")} Upload a song</button> <button type="button" class="strify-btn" data-strify-find-more${S.mine.status === "loading" ? " disabled" : ""} title="Search deeper, and on the relays in your own relay list">${icon("fa-magnifying-glass")} Find missing songs</button></div>`;
  if (!mine.length) {
    if (S.mine.status === "idle" || S.mine.status === "loading") return `${head}${skeleton()}`;
    if (S.mine.status === "error") return `${head}${stateBlock("error", "Couldn't load your uploads", "", retryButton("library"))}`;
    return `${head}${stateBlock("empty", "No uploads yet", "Songs you publish from Create show up here.")}`;
  }
  const hidden = mine.filter((t) => !isRealMusic(t)).length;
  return `${head}<p class="strify-note">${mine.length} song${mine.length === 1 ? "" : "s"} published from your account.${hidden ? ` ${hidden} ${hidden === 1 ? "is" : "are"} hidden from Home because the info is incomplete.` : ""}${scanNote()}</p>${grid("lib-uploads", mine, "Your uploads")}`;
}

function likedHtml() {
  const l = S.likes;
  if (!l.tracks.length) {
    if (l.status === "idle" || l.status === "loading") return skeleton();
    if (l.status === "error") return stateBlock("error", "Couldn't load your liked songs", "", retryButton("library"));
    return stateBlock("empty", "No liked songs yet", "Tap the heart on any song to save it here.", `<button type="button" class="strify-btn" data-strify-goto="search">${icon("fa-magnifying-glass")} Find music</button>`);
  }
  return `<p class="strify-note">${l.tracks.length} liked song${l.tracks.length === 1 ? "" : "s"}.</p>${grid("lib-liked", l.tracks, "Liked songs")}`;
}

// ── Create (upload) ────────────────────────────────────────────────
function scanNote() {
  const sc = S.mine.scan; if (!sc) return "";
  const hid = sc.hidden ? ` ${sc.hidden} more event${sc.hidden === 1 ? "" : "s"} had no playable audio URL${sc.titles.length ? ` (${sc.titles.map(E).join(", ")}${sc.hidden > sc.titles.length ? ", …" : ""})` : ""}.` : "";
  return ` Searched ${sc.relays} relay${sc.relays === 1 ? "" : "s"}, ${sc.pages} page${sc.pages === 1 ? "" : "s"}.${hid}`;
}
function createHtml() {
  if (!host.getSession()) return signInBlock("Sign in to upload music", "Songs are published to Nostr under your account, so you need to sign in first.");
  const name = profiles.get(myPubkey())?.name || "";
  return `<form class="strify-create" data-strify-create-form novalidate>
    <div class="strify-create-head"><h2>${icon("fa-cloud-arrow-up")} Upload a song</h2>
      <p class="strify-note">Your files go to a Blossom media server and the song is published as a public Nostr event (kind 1808). Anyone can play, share and zap it.</p></div>
    <fieldset class="strify-step"><legend><span>1</span> Audio file</legend>
      <label class="strify-drop">${icon("fa-file-audio")}<strong data-strify-audio-name>Choose audio</strong><small>MP3, M4A, WAV, FLAC, OGG · up to ${formatBytes(UPLOAD.maxAudioBytes)}</small>
        <input type="file" name="audio" accept="audio/*,.mp3,.m4a,.aac,.ogg,.opus,.wav,.flac" data-strify-audio-file></label>
      <p class="strify-file-info" data-strify-audio-info role="status"></p></fieldset>
    <fieldset class="strify-step"><legend><span>2</span> Cover art</legend>
      <div class="strify-cover-pick"><span data-strify-cover-box>${coverHtml("")}</span>
        <label class="strify-drop is-compact">${icon("fa-image")}<strong data-strify-cover-name>Choose cover</strong><small>JPG, PNG or WebP · square works best · up to ${formatBytes(UPLOAD.maxCoverBytes)}</small>
          <input type="file" name="cover" accept="image/jpeg,image/png,image/webp" data-strify-cover-file></label></div></fieldset>
    <fieldset class="strify-step"><legend><span>3</span> Details</legend>
      <label>Title<input name="title" maxlength="120" autocomplete="off" required></label>
      <label>Artist<input name="artist" maxlength="120" autocomplete="off" value="${E(name)}" required></label>
      <div class="strify-two"><label>Genre<select name="genre" required><option value="">Choose…</option>${GENRES.map((g) => `<option>${E(g)}</option>`).join("")}</select></label>
        <label>License<select name="license">${LICENSES.map((l) => `<option>${E(l)}</option>`).join("")}</select></label></div>
      <p class="strify-note">Songs need a title, artist, cover, genre and a length of at least ${QUALITY.minSeconds} seconds to appear on Home.</p></fieldset>
    <fieldset class="strify-step"><legend><span>4</span> Rights &amp; copyright check</legend>
      <p class="strify-note">Before uploading, strify checks Nostr and MusicBrainz for a released song with the same title. It compares metadata only (no audio fingerprinting), so a clean result is not clearance.</p>
      <button type="button" class="strify-btn" data-strify-check-copyright>${icon("fa-shield-halved")} Check for copyright matches</button>
      <div data-strify-check-result aria-live="polite"></div>
      <label class="strify-check-row"><input type="checkbox" name="rights"> <span>I made this song, or I have permission to publish it, and I understand it will be public on Nostr.</span></label></fieldset>
    <p class="strify-status" data-strify-create-status role="status"></p>
    <div class="strify-form-actions"><button type="submit" class="strify-btn is-primary" data-strify-create-submit>${icon("fa-cloud-arrow-up")} Check, upload &amp; publish</button></div>
  </form>`;
}

function checkPanelHtml(check) {
  if (!check) return "";
  if (check.verdict === "clear") return `<div class="strify-check is-clear">${icon("fa-circle-check")}<div><strong>No matches found</strong><p>Nothing matching “${E(check.title)}” turned up on Nostr or MusicBrainz. This can't catch everything, so only publish music you have the rights to.</p></div></div>`;
  if (check.verdict === "unavailable") return `<div class="strify-check is-warn">${icon("fa-triangle-exclamation")}<div><strong>Couldn't run the check</strong><p>MusicBrainz didn't respond. You can still publish after confirming you have the rights below.</p></div></div>`;
  const items = check.matches.map((m) => `<li><strong>${E(m.title)}</strong> · ${E(m.artist)}<small>${E(m.detail)}${m.url ? ` · <a href="${E(m.url)}" target="_blank" rel="noopener noreferrer">details</a>` : ""}</small></li>`).join("");
  return `<div class="strify-check is-review">${icon("fa-triangle-exclamation")}<div><strong>Possible match${check.matches.length === 1 ? "" : "es"} found</strong><p>These look like existing songs. That's fine if it's your own release or you have permission.</p><ul>${items}</ul>
    <label class="strify-check-row"><input type="checkbox" name="confirmMatch"> <span>I've reviewed these matches. This song is my own work, or I have permission to publish it.</span></label></div></div>`;
}

function paintToolbar() {
  const bar = document.querySelector("[data-strify-feedbar]");
  if (!bar) return;
  const showSearch = !S.artist && S.tab === "search";
  const showView = !!S.artist || S.tab === "search" || (S.tab === "library" && S.libTab !== "playlists");
  bar.hidden = !showSearch && !showView;
  const search = bar.querySelector("[data-strify-search-wrap]");
  if (search) search.hidden = !showSearch;
  const toggle = bar.querySelector(".strify-viewtoggle");
  if (toggle) toggle.hidden = !showView;
  const input = bar.querySelector("[data-strify-search]");
  if (input && input.value !== S.query) input.value = S.query;
  bar.querySelector("[data-strify-search-clear]")?.toggleAttribute("hidden", !S.query);
  bar.querySelectorAll("[data-strify-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.strifyView === S.viewMode)));
}

function paintBody() {
  const body = document.getElementById("strifyBody");
  if (!body || !pageActive) return;
  document.querySelectorAll("[data-strify-tab]").forEach((b) => b.setAttribute("aria-selected", String(!S.artist && b.dataset.strifyTab === S.tab)));
  paintToolbar(); paintShareToggle();
  if (S.artist) { body.innerHTML = artistHtml(); syncUi(); return; }
  // Never rebuild the upload form while someone is filling it in (relay data arriving would wipe their files).
  if (S.tab === "create" && !S.create.dirtyRender && body.querySelector("[data-strify-create-form]")) { syncUi(); return; }
  S.create.dirtyRender = false;
  body.innerHTML = S.tab === "home" ? homeHtml() : S.tab === "search" ? searchHtml() : S.tab === "library" ? libraryHtml() : createHtml();
  syncUi();
}

// ── Playlists tab ──────────────────────────────────────────────────
function syncSessionStore() {
  const session = host.getSession();
  if (!session) { storeUnsub?.(); store = null; storeUnsub = null; return; }
  if (store && store.pubkey === session.pubkeyHex) return;
  storeUnsub?.();
  store = new PlaylistStore({
    pubkey: session.pubkeyHex,
    fetchEvents: (filters) => net.fetch(filters, { urls: playlistRelays(), timeout: DISCOVERY.fetchTimeout }),
    publish: (template) => host.publish(template),
    isPremium: () => host.isPremium(),
  });
  storeUnsub = store.subscribe(() => { if (pageActive && onPlaylists()) paintBody(); });
}
const playlistRelays = () => userRelays();
async function loadPlaylists() { syncSessionStore(); if (store && store.status !== "loading") await store.load(); }

function tierNote() {
  const premium = host.isPremium();
  const lim = limitsFor(premium);
  const count = store?.playlists.length || 0;
  return `<p class="strify-tier">${count}/${lim.maxPlaylists} playlist${lim.maxPlaylists === 1 ? "" : "s"}, up to ${lim.maxTracksPerPlaylist} tracks each.</p>
    <p class="strify-privacy">${icon("fa-globe")} Playlists are saved as public Nostr events (kind 30078) — anyone can read them. They are not private.</p>`;
}

function playlistsHtml() {
  if (!host.getSession()) return stateBlock("empty", "Sign in to build playlists", "Playlists are saved to your Nostr relays, so you need to sign in.", `<button type="button" class="strify-btn" data-strify-signin>${icon("fa-arrow-right-to-bracket")} Sign in</button>`);
  if (!store || store.status === "idle" || (store.status === "loading" && !store.playlists.length)) return skeleton();
  if (S.view) { const p = store.get(S.view); if (p) return playlistDetailHtml(p); S.view = null; }
  const gate = checkCreate(store.playlists.length, host.isPremium());
  const banner = store.status === "error" ? `<div class="strify-banner" role="alert">${icon("fa-triangle-exclamation")} Couldn't sync with your relays (${E(store.error)}).${store.playlists.length ? " Showing the local cache." : ""} <button type="button" class="strify-link" data-strify-retry="playlists">Retry</button></div>` : "";
  const cards = store.playlists.map((p) => `<article class="strify-card strify-playlist-card">
      <button type="button" class="strify-card-art" data-strify-open-playlist="${E(p.d)}" aria-label="Open playlist ${E(p.name)}">${coverHtml(p.cover, "")}<span class="strify-card-play">${icon("fa-chevron-right")}</span></button>
      <div class="strify-card-meta"><strong>${E(p.name)}</strong><span>${p.tracks.length} track${p.tracks.length === 1 ? "" : "s"}${store.unsynced.has(p.d) ? " · not confirmed on relays" : ""}</span></div></article>`).join("");
  return `${banner}${tierNote()}
    <div class="strify-toolbar"><button type="button" class="strify-btn is-primary" data-strify-new-playlist ${gate.ok ? "" : 'aria-disabled="true"'}>${icon("fa-plus")} New playlist</button>${gate.ok ? "" : `<span class="strify-limit-msg" role="status">${E(gate.message)}</span>`}</div>
    ${cards ? `<div class="strify-grid">${cards}</div>` : stateBlock("empty", "No playlists yet", "Create one, then add tracks from For You or Global.")}`;
}

function playlistDetailHtml(p) {
  const rows = p.tracks.map((ref, i) => {
    const key = refKey(ref); const t = refCache.get(key) ?? tracksByKey.get(key);
    const fav = t ? `<button type="button" class="strify-row-main" data-strify-play-playlist-at="${i}" aria-label="Play ${E(t.title)}">${coverHtml(t.coverArt)}<span class="strify-row-text"><strong>${E(t.title)}</strong><small>${E(artistOf(t))}</small></span><span class="strify-row-dur">${t.duration ? formatDuration(t.duration) : ""}</span></button>`
      : `<div class="strify-row-main is-unavailable">${coverHtml("")}<span class="strify-row-text"><strong>${refCache.has(key) ? "Track unavailable" : "Loading track…"}</strong><small>${E(shorten(ref.id, 8, 6))}</small></span></div>`;
    return `<li class="strify-row" data-strify-row="${E(key)}">${fav}<span class="strify-row-actions">
      <button type="button" data-strify-move="${E(key)}" data-delta="-1" aria-label="Move up" ${i === 0 ? "disabled" : ""}>${icon("fa-arrow-up")}</button>
      <button type="button" data-strify-move="${E(key)}" data-delta="1" aria-label="Move down" ${i === p.tracks.length - 1 ? "disabled" : ""}>${icon("fa-arrow-down")}</button>
      <button type="button" data-strify-remove-track="${E(key)}" aria-label="Remove from playlist">${icon("fa-xmark")}</button></span></li>`;
  }).join("");
  void resolveRefs(p.tracks);
  return `<button type="button" class="strify-link strify-back" data-strify-back>${icon("fa-chevron-left")} All playlists</button>
    <div class="strify-detail-head">${coverHtml(p.cover, "")}<div><p class="strify-eyebrow">Playlist${store.unsynced.has(p.d) ? " · not confirmed on relays" : ""}</p><h2>${E(p.name)}</h2>${p.description ? `<p>${E(p.description)}</p>` : ""}<p class="strify-note">${p.tracks.length}/${limitsFor(host.isPremium()).maxTracksPerPlaylist} tracks</p></div></div>
    <div class="strify-toolbar">
      <button type="button" class="strify-btn is-primary" data-strify-play-playlist>${icon("fa-play")} Play</button>
      <button type="button" class="strify-btn" data-strify-add-songs>${icon("fa-plus")} Add songs</button>
      <button type="button" class="strify-btn" data-strify-edit-playlist>${icon("fa-pen")} Edit</button>
      <button type="button" class="strify-btn" data-strify-share-playlist>${icon("fa-share-nodes")} Share to feed</button>
      <button type="button" class="strify-btn is-danger" data-strify-delete-playlist>${icon("fa-trash")} Delete</button>
    </div>
    ${tierNote()}
    ${rows ? `<ol class="strify-rows">${rows}</ol>` : stateBlock("empty", "This playlist is empty", "Use the playlist button on any track to add it.")}`;
}

/** Look up tracks a playlist references (by event id, or by coordinate for 31337). Missing ones are marked unavailable. */
async function resolveRefs(refs) {
  const todo = refs.filter((r) => !refCache.has(refKey(r)) && !tracksByKey.has(refKey(r)));
  for (const r of refs) { const t = tracksByKey.get(refKey(r)); if (t) refCache.set(refKey(r), t); }
  if (!todo.length) return refs.map((r) => refCache.get(refKey(r)) || null);
  const filters = [];
  const ids = todo.filter((r) => !r.d).map((r) => r.id); if (ids.length) filters.push({ ids });
  for (const pk of new Set(todo.filter((r) => r.d).map((r) => r.pubkey))) filters.push({ kinds: [AUDIO_TRACK_KIND], authors: [pk], "#d": todo.filter((r) => r.pubkey === pk && r.d).map((r) => r.d) });
  const urls = musicAndUserRelays();
  try {
    const { tracks } = await discover(filters, urls);
    for (const r of todo) { const t = tracks.find((x) => x.key === refKey(r)) || tracks.find((x) => x.eventId === r.id); refCache.set(refKey(r), t || null); }
  } catch { /* leave unresolved; will retry next open */ }
  if (pageActive && onPlaylists()) paintBody();
  return refs.map((r) => refCache.get(refKey(r)) || null);
}

// ── Create: choose files, check, upload, publish ───────────────────
const createStatus = (text, kind = "") => {
  const el = document.querySelector("[data-strify-create-status]");
  if (el) { el.textContent = text; el.dataset.kind = kind; }
};
const createForm = () => document.querySelector("[data-strify-create-form]");
const fileKey = (file) => `${file.name}:${file.size}:${file.lastModified}`;
const titleFromFilename = (name) => String(name || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

function readAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let timer = null;
    const finish = (fn, value) => { clearTimeout(timer); URL.revokeObjectURL(url); audio.removeAttribute("src"); fn(value); };
    timer = setTimeout(() => finish(reject, new Error("timed out")), 10_000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? finish(resolve, audio.duration) : finish(reject, new Error("no duration")));
    audio.onerror = () => finish(reject, new Error("unreadable"));
    audio.src = url;
  });
}

async function onAudioChosen(input) {
  const file = input.files?.[0] || null;
  const info = document.querySelector("[data-strify-audio-info]");
  const nameEl = document.querySelector("[data-strify-audio-name]");
  Object.assign(S.create, { audio: null, duration: 0 });
  if (!file) { if (nameEl) nameEl.textContent = "Choose audio"; if (info) info.textContent = ""; return; }
  const problem = validateAudioFile(file);
  if (problem) { input.value = ""; if (nameEl) nameEl.textContent = "Choose audio"; if (info) { info.textContent = problem; info.dataset.kind = "error"; } return; }
  if (nameEl) nameEl.textContent = file.name;
  if (info) { info.textContent = `${formatBytes(file.size)} · reading length…`; info.dataset.kind = ""; }
  try {
    const seconds = await readAudioDuration(file);
    if (input.files?.[0] !== file) return;
    S.create.audio = file; S.create.duration = Math.round(seconds);
    const short = seconds < QUALITY.minSeconds;
    if (info) { info.textContent = `${formatBytes(file.size)} · ${formatDuration(seconds)}${short ? ` · too short: songs need at least ${QUALITY.minSeconds} seconds` : ""}`; info.dataset.kind = short ? "error" : "ok"; }
    const title = createForm()?.elements.title;
    if (title && !title.value.trim()) title.value = titleFromFilename(file.name);
  } catch {
    if (info) { info.textContent = "This browser couldn't read that audio file. Try an MP3 or M4A."; info.dataset.kind = "error"; }
    input.value = "";
  }
}

function onCoverChosen(input) {
  const file = input.files?.[0] || null;
  const nameEl = document.querySelector("[data-strify-cover-name]");
  const box = document.querySelector("[data-strify-cover-box]");
  if (S.create.coverUrl) { URL.revokeObjectURL(S.create.coverUrl); S.create.coverUrl = ""; }
  S.create.cover = null;
  if (!file) { if (nameEl) nameEl.textContent = "Choose cover"; if (box) box.innerHTML = coverHtml(""); return; }
  const problem = validateCoverFile(file);
  if (problem) { input.value = ""; createStatus(problem, "error"); if (nameEl) nameEl.textContent = "Choose cover"; if (box) box.innerHTML = coverHtml(""); return; }
  S.create.cover = file; S.create.coverUrl = URL.createObjectURL(file);
  if (nameEl) nameEl.textContent = file.name;
  if (box) box.innerHTML = `<span class="strify-cover"><img src="${S.create.coverUrl}" alt="Cover preview"></span>`;
  createStatus("");
}

const detailsOf = (form) => validateDetails({ title: form.elements.title.value, artist: form.elements.artist.value, genre: form.elements.genre.value, license: form.elements.license.value });
const checkKeyOf = ({ title, artist }) => `${title.toLowerCase()}|${artist.toLowerCase()}`;

async function runCopyright(form, values) {
  const result = document.querySelector("[data-strify-check-result]");
  if (result) result.innerHTML = `<p class="strify-note">${icon("fa-circle-notch fa-spin")} Checking Nostr and MusicBrainz…</p>`;
  const check = await checkCopyright({ title: values.title, artist: values.artist, me: myPubkey(), knownTracks: [...tracksByKey.values()], fetchImpl: (...args) => window.fetch(...args) });
  const full = { ...check, title: values.title };
  S.create.check = full; S.create.checkKey = checkKeyOf(values);
  if (result) result.innerHTML = checkPanelHtml(full);
  return full;
}

async function onCheckCopyright() {
  const form = createForm(); if (!form || S.create.busy) return;
  const d = detailsOf(form);
  if (d.errors.title || d.errors.artist) { createStatus(d.errors.title || d.errors.artist, "error"); return; }
  const button = form.querySelector("[data-strify-check-copyright]");
  button.disabled = true; createStatus("");
  try { await runCopyright(form, d.values); } finally { button.disabled = false; }
}

async function mediaServers() {
  let own = [];
  try {
    const events = await net.fetch([{ kinds: [10063], authors: [myPubkey()], limit: 3 }], { urls: userRelays(), timeout: 4000 });
    own = serversFromEvent(events.sort((a, b) => b.created_at - a.created_at)[0]);
  } catch { /* defaults below */ }
  return [...new Set([...own, ...UPLOAD.blossomServers])];
}

async function uploadOnce(file, servers, label) {
  const key = fileKey(file);
  if (S.create.uploaded.has(key)) return S.create.uploaded.get(key); // a retry after a failed publish doesn't upload twice
  const { url } = await uploadFile({ file, servers, sign: (template) => host.sign(template), fallback: (f) => host.uploadFallback(f), onTry: (name) => createStatus(`Uploading ${label} to ${name}…`) });
  S.create.uploaded.set(key, url);
  return url;
}

async function submitCreate(form) {
  if (S.create.busy) return;
  if (!requireSigner("Sign in to upload music.")) return;
  const d = detailsOf(form);
  const first = d.errors.title || d.errors.artist || d.errors.genre;
  if (first) { createStatus(first, "error"); form.elements[d.errors.title ? "title" : d.errors.artist ? "artist" : "genre"].focus(); return; }
  const { audio, cover } = S.create;
  const problem = (!audio && "Choose an audio file.") || validateAudioFile(audio) || (!cover && "Choose cover art.") || validateCoverFile(cover);
  if (problem) { createStatus(problem, "error"); return; }
  if (S.create.duration < QUALITY.minSeconds) { createStatus(`Songs must be at least ${QUALITY.minSeconds} seconds long.`, "error"); return; }
  if (!form.elements.rights.checked) { createStatus("Please confirm you made this song or have permission to publish it.", "error"); form.elements.rights.focus(); return; }

  S.create.busy = true;
  const submit = form.querySelector("[data-strify-create-submit]");
  form.querySelectorAll("button, input, select").forEach((el) => { el.disabled = true; });
  try {
    let check = S.create.check && S.create.checkKey === checkKeyOf(d.values) ? S.create.check : null;
    if (!check) { createStatus("Checking for copyright matches…"); check = await runCopyright(form, d.values); }
    if (check.verdict === "review" && !form.elements.confirmMatch?.checked) {
      createStatus("Possible match found. Review it above and tick the confirmation to continue.", "error");
      return;
    }
    createStatus("Finding your media servers…");
    const servers = await mediaServers();
    const audioUrl = await uploadOnce(audio, servers, "audio");
    const coverUrl = await uploadOnce(cover, servers, "cover art");
    createStatus("Publishing to your relays…");
    const template = buildTrackTemplate({ url: audioUrl, coverArt: coverUrl, ...d.values, duration: S.create.duration });
    const { signed, result } = await host.publish(template);
    if (!result?.accepted?.length) throw new Error("Your files are uploaded, but no relay accepted the song. Press publish again to retry.");
    const parsed = parseAudioEvent(signed);
    if (parsed?.track) { rawEvents.set(signed.id, signed); register(parsed.track); S.mine.tracks = dedupeTracks([parsed.track, ...S.mine.tracks]); S.mine.pubkey = myPubkey(); S.mine.status = "ready"; }
    host.toast(`Published “${d.values.title}” · ${result.accepted.length} relay${result.accepted.length === 1 ? "" : "s"} confirmed.`);
    if (S.create.coverUrl) URL.revokeObjectURL(S.create.coverUrl);
    Object.assign(S.create, { audio: null, cover: null, duration: 0, coverUrl: "", check: null, checkKey: "", dirtyRender: true });
    S.create.uploaded.clear();
    S.tab = "library"; S.libTab = "uploads"; paintBody();
  } catch (error) {
    createStatus(error?.message || "Upload failed. Try again.", "error");
  } finally {
    S.create.busy = false;
    const live = createForm();
    if (live) { live.querySelectorAll("button, input, select").forEach((el) => { el.disabled = false; }); }
    submit?.blur?.();
  }
}

function confirmDeleteTrack(track) {
  openModal(`<form class="strify-form"><h2>Remove “${E(track.title)}”?</h2>
    <p class="strify-note">This asks your relays to delete the song's Nostr event (NIP-09). The audio and cover files stay on the media server, and copies cached elsewhere may linger.</p>
    <p class="strify-status" data-strify-status role="status"></p>
    <div class="strify-form-actions"><button type="button" class="strify-btn" data-strify-close>Cancel</button><button type="submit" class="strify-btn is-danger">Remove</button></div></form>`,
  { label: "Remove song", onSubmit: async (_data, wrap) => {
    modalStatus(wrap, "Publishing deletion…");
    try {
      const { result } = await host.publish({ kind: DELETION_KIND, tags: [["e", track.eventId], ["k", String(track.kind)]], content: "" });
      if (!result?.accepted?.length) { modalStatus(wrap, "No relay accepted the deletion. Try again."); return; }
      const gone = (t) => t.eventId !== track.eventId;
      S.mine.tracks = S.mine.tracks.filter(gone); S.forYou.tracks = S.forYou.tracks.filter(gone); S.global.tracks = S.global.tracks.filter(gone); S.likes.tracks = S.likes.tracks.filter(gone);
      tracksByKey.delete(track.key);
      closeModal(); host.toast("Song removed."); paintBody();
    } catch (error) { modalStatus(wrap, error?.message || "Couldn't sign the deletion."); }
  } });
}

// Edit one of your own uploads. Kind 1808 is a regular event, so the edit publishes a corrected copy and then asks relays to delete the old one.
function openEditTrack(track) {
  if (!requireSigner("Sign in to edit your songs.")) return;
  const original = rawEvents.get(track.eventId);
  const currentLicense = licenseOfEvent(original);
  const genres = GENRES.some((g) => g.toLowerCase() === track.genre.toLowerCase()) || !track.genre ? GENRES : [track.genre, ...GENRES];
  const licenses = !currentLicense || LICENSES.includes(currentLicense) ? LICENSES : [currentLicense, ...LICENSES];
  const opt = (value, current) => `<option${value === current ? " selected" : ""}>${E(value)}</option>`;
  let uploadedCover = ""; // a retry after a failed publish doesn't upload the new cover twice
  let uploadedKey = "";
  const wrap = openModal(`<form class="strify-form" novalidate><h2>Edit song</h2>
    <label>Title<input name="title" maxlength="120" autocomplete="off" required autofocus value="${E(track.title === "Untitled track" ? "" : track.title)}"></label>
    <label>Artist<input name="artist" maxlength="120" autocomplete="off" required value="${E(track.artist)}"></label>
    <div class="strify-two"><label>Genre<select name="genre" required>${track.genre ? "" : '<option value="">Choose…</option>'}${genres.map((g) => opt(g, track.genre)).join("")}</select></label>
      <label>License<select name="license">${currentLicense ? "" : '<option value="">Not specified</option>'}${licenses.map((l) => opt(l, currentLicense)).join("")}</select></label></div>
    <div class="strify-cover-pick"><span data-strify-edit-cover-box>${coverHtml(track.coverArt)}</span>
      <label class="strify-drop is-compact">${icon("fa-image")}<strong data-strify-edit-cover-name>${track.coverArt ? "Replace cover" : "Choose cover"}</strong><small>JPG, PNG or WebP · up to ${formatBytes(UPLOAD.maxCoverBytes)}</small>
        <input type="file" name="cover" accept="image/jpeg,image/png,image/webp"></label></div>
    <p class="strify-note">The audio stays as it is. Saving publishes an updated copy of the song and asks your relays to delete the old one (NIP-09). Likes, comments and playlist entries that pointed at the old copy won't carry over.</p>
    <p class="strify-status" data-strify-status role="status"></p>
    <div class="strify-form-actions"><button type="button" class="strify-btn" data-strify-close>Cancel</button><button type="submit" class="strify-btn is-primary">${icon("fa-floppy-disk")} Save changes</button></div></form>`,
  { label: "Edit song", onSubmit: async (data, w) => {
    const d = validateDetails({ title: data.get("title"), artist: data.get("artist"), genre: data.get("genre"), license: data.get("license") });
    const coverFile = data.get("cover") instanceof File && data.get("cover").size ? data.get("cover") : null;
    const problem = d.errors.title || d.errors.artist || d.errors.genre || (coverFile && validateCoverFile(coverFile)) || (!coverFile && !track.coverArt && "Choose cover art.") || "";
    if (problem) { modalStatus(w, problem); return; }
    const same = d.values.title === track.title && d.values.artist === track.artist && d.values.genre === track.genre && d.values.license === currentLicense;
    if (same && !coverFile) { closeModal(); return; }
    const btn = w.querySelector("button[type=submit]"); btn.disabled = true;
    try {
      let coverArt = "";
      if (coverFile) {
        const key = fileKey(coverFile);
        if (uploadedKey !== key) {
          modalStatus(w, "Finding your media servers…");
          const servers = await mediaServers();
          uploadedCover = (await uploadFile({ file: coverFile, servers, sign: (template) => host.sign(template), fallback: (f) => host.uploadFallback(f), onTry: (name) => modalStatus(w, `Uploading cover art to ${name}…`) })).url;
          uploadedKey = key;
        }
        coverArt = uploadedCover;
      }
      modalStatus(w, "Publishing to your relays…");
      const template = buildEditedTemplate({ track, original, ...d.values, coverArt });
      const { signed, result } = await host.publish(template);
      if (!result?.accepted?.length) { modalStatus(w, "No relay accepted the updated song. Try again."); btn.disabled = false; return; }
      const parsed = parseAudioEvent(signed);
      let removedOld = false;
      try { removedOld = !!(await host.publish({ kind: DELETION_KIND, tags: [["e", track.eventId], ["k", String(track.kind)]], content: "" })).result?.accepted?.length; } catch { /* reported below */ }
      const gone = (t) => t.eventId !== track.eventId;
      S.mine.tracks = S.mine.tracks.filter(gone); S.forYou.tracks = S.forYou.tracks.filter(gone); S.global.tracks = S.global.tracks.filter(gone); S.likes.tracks = S.likes.tracks.filter(gone);
      tracksByKey.delete(track.key);
      if (parsed?.track) { rawEvents.set(signed.id, signed); register(parsed.track); S.mine.tracks = dedupeTracks([parsed.track, ...S.mine.tracks]); S.mine.pubkey = myPubkey(); S.mine.status = "ready"; }
      closeModal();
      host.toast(removedOld ? `Saved “${d.values.title}”.` : `Saved “${d.values.title}”, but no relay confirmed deleting the old copy. You may see both for a while; remove the old one from Uploads if it stays.`);
      paintBody();
    } catch (error) { modalStatus(w, error?.message || "Couldn't save. Check your signer and try again."); btn.disabled = false; }
  } });
  wrap.querySelector("input[name=cover]")?.addEventListener("change", (event) => {
    const file = event.currentTarget.files?.[0]; const box = wrap.querySelector("[data-strify-edit-cover-box]"); const name = wrap.querySelector("[data-strify-edit-cover-name]");
    if (!file) return;
    const problem = validateCoverFile(file);
    if (problem) { event.currentTarget.value = ""; modalStatus(wrap, problem); return; }
    modalStatus(wrap, ""); if (name) name.textContent = file.name;
    if (box) box.innerHTML = `<span class="strify-cover"><img src="${URL.createObjectURL(file)}" alt="New cover preview"></span>`;
  });
}

// ── Modals ─────────────────────────────────────────────────────────
function openModal(html, { onSubmit, label }) {
  closeModal();
  const wrap = document.createElement("div");
  wrap.className = "strify-modal-backdrop"; wrap.id = "strifyModal";
  wrap.innerHTML = `<div class="strify-modal" role="dialog" aria-modal="true" aria-label="${E(label)}">${html}</div>`;
  document.body.appendChild(wrap);
  const previous = document.activeElement;
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-strify-close]")) closeModal(); });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeModal(); return; }
    if (e.key === "Tab") { const f = [...wrap.querySelectorAll("button:not([disabled]), input, textarea, select, a[href]")]; if (!f.length) return; const first = f[0], last = f.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
  });
  wrap.querySelector("form")?.addEventListener("submit", (e) => { e.preventDefault(); onSubmit?.(new FormData(e.currentTarget), wrap); });
  wrap._restore = previous;
  (wrap.querySelector("[autofocus], input, textarea, button") || wrap).focus();
  return wrap;
}
function closeModal() { const m = document.getElementById("strifyModal"); if (m) { m._restore?.focus?.(); m.remove(); } }
const modalStatus = (wrap, text) => { const s = wrap.querySelector("[data-strify-status]"); if (s) s.textContent = text; };

function playlistForm(p) {
  const html = `<form class="strify-form"><h2>${p ? "Edit playlist" : "New playlist"}</h2>
    <label>Name<input name="name" maxlength="80" required autofocus value="${E(p?.name || "")}"></label>
    <label>Description<textarea name="description" rows="3" maxlength="500">${E(p?.description || "")}</textarea></label>
    <label>Cover image URL (https)<input name="cover" type="url" inputmode="url" placeholder="https://…" value="${E(p?.cover || "")}"></label>
    <div class="strify-cover-preview" data-strify-cover-preview>${coverHtml(p?.cover || "")}</div>
    <p class="strify-privacy">${icon("fa-globe")} Saved as a public Nostr event. Anyone can read it.</p>
    <p class="strify-status" data-strify-status role="status"></p>
    <div class="strify-form-actions"><button type="button" class="strify-btn" data-strify-close>Cancel</button><button type="submit" class="strify-btn is-primary">${p ? "Save" : "Create"}</button></div></form>`;
  return html;
}
document.addEventListener("input", (event) => {
  const input = event.target.closest?.("#strifyModal input[name=cover]");
  if (!input) return;
  const box = document.querySelector("[data-strify-cover-preview]");
  const ok = /^https:\/\//i.test(input.value.trim());
  if (box) box.innerHTML = coverHtml(ok ? input.value.trim() : "");
});

async function submitPlaylistForm(data, wrap, existing, firstTrack) {
  const btn = wrap.querySelector("button[type=submit]"); btn.disabled = true; modalStatus(wrap, "Publishing to your relays…");
  const fields = { name: data.get("name"), description: data.get("description"), cover: String(data.get("cover") || "").trim() };
  try {
    const result = existing ? await store.edit(existing.d, fields) : await store.create({ ...fields, firstTrack });
    if (!result.ok) { modalStatus(wrap, result.message); btn.disabled = false; return result; }
    closeModal(); host.toast(`${existing ? "Playlist saved" : "Playlist created"} · ${result.relays} relay${result.relays === 1 ? "" : "s"} confirmed.`);
    if (!existing) S.view = result.playlist.d;
    if (pageActive) { S.tab = "library"; S.libTab = "playlists"; paintBody(); }
    return result;
  } catch (error) { modalStatus(wrap, error?.message || "Couldn't sign or publish. Check your signer."); btn.disabled = false; }
}

function requireSigner(message) {
  if (!host.getSession()) { host.signIn(message); return false; }
  return true;
}

function openAddToPlaylist(track) {
  if (!HEX64.test(track.eventId || "")) { host.toast("This track can't be added to a playlist."); return; }
  if (!requireSigner("Sign in to add tracks to a playlist.")) return;
  syncSessionStore();
  void (async () => {
    if (store.status === "idle" || store.status === "error") await store.load();
    const premium = host.isPremium();
    const items = store.playlists.map((p) => {
      const gate = checkAddTrack(p, trackRef(track), premium);
      return `<li><button type="button" class="strify-pick" data-strify-pick="${E(p.d)}" ${gate.ok ? "" : "disabled"}>${coverHtml(p.cover)}<span><strong>${E(p.name)}</strong><small>${gate.ok ? `${p.tracks.length} tracks` : E(gate.message)}</small></span></button></li>`;
    }).join("");
    const gate = checkCreate(store.playlists.length, premium);
    const wrap = openModal(`<div class="strify-form"><h2>Add to playlist</h2><p class="strify-note">${E(track.title)} · ${E(artistOf(track))}</p>
      ${store.status === "error" ? `<p class="strify-banner" role="alert">Couldn't sync with relays; showing cached playlists.</p>` : ""}
      <ul class="strify-picks">${items || ""}</ul>
      <button type="button" class="strify-btn" data-strify-pick-new ${gate.ok ? "" : 'aria-disabled="true"'}>${icon("fa-plus")} New playlist with this track</button>
      ${gate.ok ? "" : `<p class="strify-limit-msg" role="status">${E(gate.message)}</p>`}
      <p class="strify-status" data-strify-status role="status"></p>
      <div class="strify-form-actions"><button type="button" class="strify-btn" data-strify-close>Close</button></div></div>`, { label: "Add to playlist" });
    wrap.addEventListener("click", async (e) => {
      const pick = e.target.closest("[data-strify-pick]");
      if (pick) {
        pick.disabled = true; modalStatus(wrap, "Publishing to your relays…");
        try {
          const result = await store.addTrack(pick.dataset.strifyPick, trackRef(track));
          if (!result.ok) { modalStatus(wrap, result.message); pick.disabled = false; return; }
          closeModal(); host.toast(`Added to “${result.playlist.name}”.`);
        } catch (error) { modalStatus(wrap, error?.message || "Couldn't publish."); pick.disabled = false; }
        return;
      }
      if (e.target.closest("[data-strify-pick-new]")) {
        if (!gate.ok) { modalStatus(wrap, gate.message); return; }
        const ref = trackRef(track);
        openModal(playlistForm(null), { label: "New playlist", onSubmit: (d, w) => submitPlaylistForm(d, w, null, ref) });
      }
    });
  })();
}

// Browse known tracks and add several to one playlist without leaving the modal.
function openSongPicker(d) {
  const render = (query = "") => {
    const p = store.get(d); if (!p) return "";
    const q = query.trim().toLowerCase();
    const premium = host.isPremium();
    const all = [...tracksByKey.values()].sort((a, b) => b.createdAt - a.createdAt)
      .filter((t) => !q || `${t.title} ${artistOf(t)} ${t.album}`.toLowerCase().includes(q)).slice(0, 80);
    if (!all.length) return stateBlock("empty", S.global.status === "loading" ? "Loading tracks…" : "No tracks to add", S.global.status === "loading" ? "" : "Open Home or Search first so tracks can be discovered, or change your search.");
    return all.map((t) => {
      const gate = checkAddTrack(p, trackRef(t), premium);
      const inList = gate.code === "duplicate";
      return `<li><button type="button" class="strify-pick" data-strify-song-add="${E(t.key)}" ${gate.ok ? "" : "disabled"}>${coverHtml(t.coverArt)}<span><strong>${E(t.title)}</strong><small>${inList ? "Already in this playlist" : gate.ok ? E(artistOf(t)) : E(gate.message)}</small></span>${gate.ok ? icon("fa-plus") : inList ? icon("fa-check") : ""}</button></li>`;
    }).join("");
  };
  const wrap = openModal(`<div class="strify-form"><h2>Add songs</h2>
    <label>Search tracks<input type="search" data-strify-song-search placeholder="Title or artist" autofocus></label>
    <p class="strify-note" data-strify-song-count></p>
    <ul class="strify-picks strify-picks-scroll" data-strify-song-list></ul>
    <p class="strify-status" data-strify-status role="status"></p>
    <div class="strify-form-actions"><button type="button" class="strify-btn is-primary" data-strify-close>Done</button></div></div>`, { label: "Add songs" });
  const list = wrap.querySelector("[data-strify-song-list]");
  const count = wrap.querySelector("[data-strify-song-count]");
  const repaint = () => {
    const p = store.get(d); if (!p) return;
    list.innerHTML = render(wrap.querySelector("[data-strify-song-search]").value);
    count.textContent = `${p.tracks.length}/${limitsFor(host.isPremium()).maxTracksPerPlaylist} tracks in “${p.name}”`;
  };
  repaint();
  void Promise.all([loadGlobal(), loadForYou()]).then(() => { if (wrap.isConnected) repaint(); });
  wrap.addEventListener("input", (e) => { if (e.target.matches("[data-strify-song-search]")) repaint(); });
  wrap.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-strify-song-add]"); if (!btn) return;
    const track = tracksByKey.get(btn.dataset.strifySongAdd); if (!track) return;
    btn.disabled = true; modalStatus(wrap, "Publishing to your relays…");
    try {
      const result = await store.addTrack(d, trackRef(track));
      modalStatus(wrap, result.ok ? "" : result.message);
      if (result.ok) refCache.set(refKey(trackRef(track)), track);
    } catch (error) { modalStatus(wrap, error?.message || "Couldn't sign or publish."); }
    repaint();
    if (pageActive && onPlaylists()) paintBody();
  });
}

// ── Track social actions ───────────────────────────────────────────
const coordOf = (t) => (t.kind === AUDIO_TRACK_KIND && t.d ? `${AUDIO_TRACK_KIND}:${t.pubkey}:${t.d}` : "");
function targetTags(t, upper = false) {
  const coord = coordOf(t);
  const rel = userRelays()[0] || "";
  return coord
    ? [[upper ? "A" : "a", coord, rel], [upper ? "K" : "k", String(t.kind)], [upper ? "P" : "p", t.pubkey]]
    : [[upper ? "E" : "e", t.eventId, rel, t.pubkey], [upper ? "K" : "k", String(t.kind)], [upper ? "P" : "p", t.pubkey]];
}
async function publishAction(label, template) {
  try {
    const { result } = await host.publish(template);
    if (!result?.accepted?.length) { host.toast(`${label} wasn't saved: no relay accepted it.`); return false; }
    return true;
  } catch (error) { host.toast(error?.message || `Couldn't sign the ${label.toLowerCase()}.`); return false; }
}
async function likeTrack(track, button) {
  if (!requireSigner("Sign in to like tracks.")) return;
  if (liked.has(track.eventId)) { host.toast("You already liked this track."); return; }
  button.disabled = true;
  const tags = [["e", track.eventId, (userRelays()[0] || ""), track.pubkey], ...(coordOf(track) ? [["a", coordOf(track), (userRelays()[0] || "")]] : []), ["p", track.pubkey], ["k", String(track.kind)]];
  const ok = await publishAction("Like", { kind: 7, tags, content: "❤️" });
  button.disabled = false;
  if (ok) {
    liked.add(track.eventId); button.classList.add("is-active"); button.setAttribute("aria-pressed", "true"); host.toast("Liked.");
    if (S.likes.pubkey === myPubkey()) S.likes.tracks = [track, ...S.likes.tracks.filter((t) => t.eventId !== track.eventId)];
  }
}
async function repostTrack(track, button) {
  if (!requireSigner("Sign in to repost tracks.")) return;
  const raw = rawEvents.get(track.eventId);
  const content = raw && JSON.stringify(raw).length < 8000 ? JSON.stringify(raw) : "";
  button.disabled = true;
  const ok = await publishAction("Repost", { kind: REPOST_KIND, tags: [["e", track.eventId, (userRelays()[0] || "")], ["p", track.pubkey], ["k", String(track.kind)], ...(coordOf(track) ? [["a", coordOf(track), (userRelays()[0] || "")]] : [])], content });
  button.disabled = false;
  if (ok) host.toast("Reposted.");
}
function openComment(track) {
  if (!requireSigner("Sign in to comment.")) return;
  openModal(`<form class="strify-form"><h2>Comment</h2><p class="strify-note">${E(track.title)} · ${E(artistOf(track))}</p>
    <label>Your comment<textarea name="text" rows="3" maxlength="2000" required autofocus></textarea></label>
    <p class="strify-status" data-strify-status role="status"></p>
    <div class="strify-form-actions"><button type="button" class="strify-btn" data-strify-close>Cancel</button><button type="submit" class="strify-btn is-primary">Post</button></div></form>`,
    { label: "Comment", onSubmit: async (data, wrap) => {
      const text = String(data.get("text") || "").trim(); if (!text) return;
      modalStatus(wrap, "Publishing…");
      const ok = await publishAction("Comment", { kind: COMMENT_KIND, tags: [...targetTags(track, true), ...targetTags(track, false)], content: text });
      if (ok) { closeModal(); host.toast("Comment posted."); } else modalStatus(wrap, "Not published — try again.");
    } });
}
function zapTrack(track) {
  if (!HEX64.test(track.eventId || "")) { host.toast("This track can't be zapped: it has no event to zap."); return; }
  if (!requireSigner("Sign in to zap.")) return;
  const p = profiles.get(track.pubkey);
  host.openZap(track.eventId, track.pubkey, p);
}

// ── Sharing a playlist as a kind 1 note ────────────────────────────
async function sharePlaylist(p) {
  if (store.unsynced.has(p.d)) { host.toast("This playlist isn't confirmed on your relays yet. Save an edit first, then share."); return; }
  const coord = playlistCoordinate(p.pubkey, p.d);
  const relay = userRelays()[0] || (userRelays()[0] || "");
  let naddr = "";
  try { const NT = await ensureNostrTools(); naddr = NT.nip19.naddrEncode({ identifier: p.d, pubkey: p.pubkey, kind: PLAYLIST_KIND, relays: [relay] }); } catch { /* the a tag still carries the reference */ }
  const content = `🎵 ${p.name}${p.description ? `\n${p.description}` : ""}\n\n${naddr ? `nostr:${naddr}\n\n` : ""}#strify`;
  const wrap = openModal(`<form class="strify-form"><h2>Share playlist</h2><p class="strify-note">This publishes a public note to your followers. Reactions, zaps and replies attach to the note.</p><pre class="strify-preview">${E(content)}</pre><p class="strify-status" data-strify-status role="status"></p><div class="strify-form-actions"><button type="button" class="strify-btn" data-strify-close>Cancel</button><button type="submit" class="strify-btn is-primary">${icon("fa-paper-plane")} Post</button></div></form>`,
    { label: "Share playlist", onSubmit: async (_d, w) => {
      modalStatus(w, "Publishing…");
      try {
        const { result } = await host.publish({ kind: 1, tags: [["a", coord, relay], ["t", "strify"]], content });
        if (!result.accepted.length) { modalStatus(w, "No relay accepted the post. It was not shared."); return; }
        closeModal(); host.toast("Playlist shared to your feed.");
      } catch (error) { modalStatus(w, error?.message || "Couldn't sign the post."); }
    } });
  return wrap;
}

// ── Shared-playlist previews inside kind 1 posts ───────────────────
async function authorWriteRelays(pubkey) {
  try {
    const ev = (await net.fetch([{ kinds: [10002], authors: [pubkey], limit: 1 }], { urls: userRelays().slice(0, 3), timeout: 3000 })).sort((a, b) => b.created_at - a.created_at)[0];
    return (ev?.tags || []).filter((t) => t[0] === "r" && /^wss:\/\//.test(t[1] || "") && (!t[2] || t[2] === "write")).map((t) => t[1]).slice(0, 3);
  } catch { return []; }
}
async function loadEmbed(info, force = false) {
  const hit = embedCache.get(info.coord);
  if (hit && !force && Date.now() - hit.at < 120_000) return hit;
  let outcome;
  try {
    const hints = [info.relay, ...(await authorWriteRelays(info.pubkey))].filter(Boolean);
    const urls = [...new Set([...hints, ...userRelays()])];
    const version = await fetchPlaylistVersion(fetchEventsFrom(urls), info.pubkey, info.d);
    if (version.state !== "ok") outcome = { state: version.state, at: Date.now() };
    else {
      const resolved = await resolveRefs(version.playlist.tracks);
      void loadArtistProfiles([{ pubkey: info.pubkey }]);
      outcome = { state: "ok", playlist: version.playlist, tracks: resolved, at: Date.now() };
    }
  } catch (error) { outcome = hit && hit.state === "ok" ? hit : { state: "error", message: error?.message, at: Date.now() }; }
  embedCache.set(info.coord, outcome);
  return outcome;
}
function embedHtml(info, data) {
  const head = (inner) => `<div class="strify-embed-inner">${inner}</div>`;
  if (!data) return head(`<div class="strify-state strify-state-loading">${icon("fa-circle-notch fa-spin")}<span>Loading playlist…</span></div>`);
  if (data.state !== "ok") return head(`<div class="strify-state strify-state-error">${icon("fa-triangle-exclamation")}<strong>${data.state === "deleted" ? "This playlist was deleted by its creator." : "Playlist unavailable"}</strong>${data.state === "deleted" ? "" : `<p>It couldn't be retrieved from the relays we can reach.</p><button type="button" class="strify-btn" data-strify-embed-retry>${icon("fa-rotate-right")} Retry</button>`}</div>`);
  const p = data.playlist; const creator = profiles.get(p.pubkey)?.name || shorten(npubFromHex(p.pubkey), 8, 4);
  const playable = data.tracks.filter(Boolean);
  const rows = p.tracks.map((ref, i) => { const t = data.tracks[i]; return `<li>${t ? `<button type="button" class="strify-embed-row" data-strify-embed-play="${i}">${icon("fa-play")}<span><strong>${E(t.title)}</strong> <small>${E(artistOf(t))}</small></span></button>` : `<span class="strify-embed-row is-unavailable"><span>Track unavailable</span></span>`}</li>`; }).join("");
  return head(`<div class="strify-embed-head">${coverHtml(p.cover)}<div><p class="strify-eyebrow">strify playlist</p><strong>${E(p.name)}</strong><small>by ${E(creator)} · ${p.tracks.length} track${p.tracks.length === 1 ? "" : "s"}</small>${p.description ? `<p>${E(p.description)}</p>` : ""}</div>
    <button type="button" class="strify-btn is-primary" data-strify-embed-play-all ${playable.length ? "" : "disabled"} aria-label="Play playlist ${E(p.name)}">${icon("fa-play")} Play</button></div>
    <ol class="strify-embed-list">${rows}</ol>`);
}
const hydrating = new WeakSet();
async function hydrateEmbed(el) {
  const info = { coord: el.dataset.strifyPlaylist, pubkey: el.dataset.strifyPubkey, d: el.dataset.strifyD, relay: el.dataset.strifyRelay || "" };
  if (!HEX64.test(info.pubkey || "")) return;
  el.innerHTML = embedHtml(info, embedCache.get(info.coord));
  if (embedCache.get(info.coord) && Date.now() - embedCache.get(info.coord).at < 120_000) return;
  const data = await loadEmbed(info);
  if (el.isConnected) el.innerHTML = embedHtml(info, data);
}
function scanEmbeds(root = document) {
  root.querySelectorAll?.("[data-strify-playlist]").forEach((el) => { if (hydrating.has(el)) return; hydrating.add(el); void hydrateEmbed(el); });
}
// ── Player UI (mini-player + full controls on /strify) ─────────────
function transportHtml(variant) {
  const full = variant === "full";
  return `<div class="strify-controls">
    ${full ? `<button type="button" data-sp="shuffle" aria-label="Shuffle" aria-pressed="false">${icon("fa-shuffle")}</button>` : ""}
    <button type="button" data-sp="prev" aria-label="Previous track">${icon("fa-backward-step")}</button>
    <button type="button" class="strify-playbtn" data-sp="toggle" aria-label="Play">${icon("fa-play")}</button>
    <button type="button" data-sp="next" aria-label="Next track">${icon("fa-forward-step")}</button>
    ${full ? `<button type="button" data-sp="repeat" aria-label="Repeat off" aria-pressed="false">${icon("fa-repeat")}</button>` : ""}
  </div>`;
}
const seekHtml = () => `<div class="strify-seek"><span data-sp-cur>0:00</span><input type="range" min="0" max="0" step="1" value="0" data-sp-seek aria-label="Seek"><span data-sp-dur>0:00</span></div>`;

function ensureMini() {
  if (document.getElementById("strifyMini")) return;
  const el = document.createElement("div");
  el.id = "strifyMini"; el.className = "strify-mini"; el.hidden = true;
  el.setAttribute("role", "region"); el.setAttribute("aria-label", "strify player");
  el.innerHTML = `<div class="strify-mini-bar" aria-hidden="true"><i data-sp-bar></i></div>
    <div class="strify-mini-inner">
      <div class="strify-mini-track"><a class="strify-mini-cover" href="/" data-route-link aria-label="Open strify"><span data-sp-cover></span></a><span class="strify-mini-text"><a class="strify-mini-title" href="/" data-route-link><strong data-sp-title></strong></a><button type="button" class="strify-artist-link" data-sp-artist data-strify-artist></button><small class="strify-mini-error" data-sp-error role="status"></small></span></div>
      ${transportHtml("mini")}
      <button type="button" class="strify-zapbtn" data-sp="zap" aria-label="Zap this track" title="Zap">${icon("fa-bolt")}</button>
      <div class="strify-mini-seek">${seekHtml()}</div>
    </div>`;
  document.body.appendChild(el);
}
let renderedKey = "";
const rangeDragging = new Set();

function syncUi() {
  const st = player.getState();
  const track = player.currentTrack();
  const mini = document.getElementById("strifyMini");
  if (!mini) return;
  mini.hidden = !track;
  document.body.classList.toggle("strify-has-player", !!track);
  const full = document.querySelector("[data-strify-fullplayer]");
  if (full) {
    full.hidden = !track;
    if (track && !full.firstElementChild) full.innerHTML = fullPlayerHtml();
  }
  const key = track ? `${track.key}|${track.title}|${track.coverArt}` : "";
  document.querySelectorAll("[data-sp-cover]").forEach((n) => { if (n.dataset.key !== key) { n.dataset.key = key; n.innerHTML = track ? coverHtml(track.coverArt) : ""; } });
  document.querySelectorAll("[data-sp-title]").forEach((n) => { n.textContent = track?.title || ""; });
  document.querySelectorAll("[data-sp-artist]").forEach((n) => {
    n.textContent = track ? artistOf(track) : "";
    if (n.hasAttribute("data-strify-artist")) { n.dataset.strifyArtist = track?.pubkey || ""; n.title = track ? `See ${artistOf(track)}'s music` : ""; n.hidden = !track; }
  });
  document.querySelectorAll("[data-sp-error]").forEach((n) => { n.textContent = st.error || (st.buffering && st.playing !== false && track ? "Buffering…" : ""); });
  document.querySelectorAll('[data-sp="toggle"]').forEach((n) => {
    const spin = st.buffering && !st.error;
    n.innerHTML = icon(spin && st.playing ? "fa-circle-notch fa-spin" : st.playing ? "fa-pause" : "fa-play");
    n.setAttribute("aria-label", st.playing ? "Pause" : "Play");
  });
  document.querySelectorAll('[data-sp="shuffle"]').forEach((n) => n.setAttribute("aria-pressed", String(st.shuffle)));
  document.querySelectorAll('[data-sp="repeat"]').forEach((n) => {
    n.setAttribute("aria-pressed", String(st.repeat !== "off"));
    n.setAttribute("aria-label", `Repeat ${st.repeat}`);
    n.innerHTML = icon(st.repeat === "one" ? "fa-1" : "fa-repeat");
    n.dataset.mode = st.repeat;
  });
  document.querySelectorAll('[data-sp="mute"]').forEach((n) => { n.innerHTML = icon(st.muted || st.volume === 0 ? "fa-volume-xmark" : st.volume < 0.5 ? "fa-volume-low" : "fa-volume-high"); n.setAttribute("aria-label", st.muted ? "Unmute" : "Mute"); n.setAttribute("aria-pressed", String(st.muted)); });
  document.querySelectorAll("[data-sp-volume]").forEach((n) => { n.value = String(st.muted ? 0 : st.volume); n.setAttribute("aria-valuetext", `${Math.round((st.muted ? 0 : st.volume) * 100)}%`); });
  document.querySelectorAll("[data-strify-card]").forEach((n) => n.classList.toggle("is-current", !!track && n.dataset.strifyCard === track.key));
  renderedKey = key;
  syncTime();
  if (document.getElementById("strifyQueue")) paintQueue();
}
function syncTime() {
  const st = player.getState();
  const dur = st.duration || 0;
  document.querySelectorAll("[data-sp-bar]").forEach((n) => { n.style.width = dur ? `${Math.min(100, (st.currentTime / dur) * 100)}%` : "0%"; });
  document.querySelectorAll("[data-sp-seek]").forEach((n) => {
    n.max = String(Math.floor(dur)); if (!rangeDragging.has(n)) n.value = String(Math.floor(st.currentTime));
    n.setAttribute("aria-valuetext", `${formatDuration(st.currentTime)} of ${formatDuration(dur)}`);
  });
  document.querySelectorAll("[data-sp-cur]").forEach((n) => { n.textContent = formatDuration(st.currentTime); });
  document.querySelectorAll("[data-sp-dur]").forEach((n) => { n.textContent = dur ? formatDuration(dur) : "–:––"; });
}
function fullPlayerHtml() {
  return `<div class="strify-full"><span class="strify-full-cover" data-sp-cover></span>
    <div class="strify-full-main"><p class="strify-eyebrow">Now playing</p><strong data-sp-title></strong><button type="button" class="strify-artist-link" data-sp-artist data-strify-artist></button><small class="strify-mini-error" data-sp-error role="status"></small>
      ${transportHtml("full")}${seekHtml()}
      <div class="strify-full-extra"><button type="button" data-sp="mute" aria-label="Mute" aria-pressed="false">${icon("fa-volume-high")}</button><input type="range" min="0" max="1" step="0.02" data-sp-volume aria-label="Volume"><button type="button" data-sp="queue" aria-label="Show queue">${icon("fa-list")} Queue</button><button type="button" data-sp="addto" aria-label="Add this track to a playlist">${icon("fa-circle-plus")} Add</button><button type="button" data-sp="zap" aria-label="Zap this track">${icon("fa-bolt")} Zap</button></div>
    </div></div>`;
}
function paintQueue() {
  const el = document.getElementById("strifyQueue"); if (!el) return;
  const st = player.getState();
  el.querySelector("[data-queue-list]").innerHTML = player.upcoming().map(({ track, pos }) => `<li><button type="button" class="strify-row-main${pos === st.pos ? " is-current" : ""}" data-strify-queue-at="${pos}" ${pos === st.pos ? 'aria-current="true"' : ""}>${coverHtml(track.coverArt)}<span class="strify-row-text"><strong>${E(track.title)}</strong><small>${E(artistOf(track))}</small></span></button></li>`).join("");
}
function openQueue() {
  if (document.getElementById("strifyQueue")) { closeQueue(); return; }
  const el = document.createElement("div");
  el.id = "strifyQueue"; el.className = "strify-queue"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Play queue");
  el.innerHTML = `<div class="strify-queue-head"><strong class="strify-queue-title">${strifyMark("strify-mark is-small")}Queue${player.getState().label ? ` · ${E(player.getState().label)}` : ""}</strong><button type="button" data-strify-queue-close aria-label="Close queue">${icon("fa-xmark")}</button></div><ol class="strify-rows" data-queue-list></ol>`;
  document.body.appendChild(el); paintQueue(); el.querySelector("button")?.focus();
}
function closeQueue() { document.getElementById("strifyQueue")?.remove(); }

function playList(name, index, label) {
  const tracks = (lists[name] || []).filter((t) => t.url);
  if (!tracks.length) return;
  pauseProfileMusic();
  player.playQueue(tracks, index, { label });
}

// ── Events ─────────────────────────────────────────────────────────
function onClick(event) {
  const t = event.target;
  const q = (sel) => t.closest(sel);
  let el;
  // The mini-player lives on <body>, outside #app where Friendstr's delegated [data-route-link] handler listens.
  // Without this, its links fall through to a real document navigation, which reloads the page and kills the audio.
  if ((el = q("a[data-route-link]")) && !el.closest("#app")) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || el.target === "_blank") return; // let "open in new tab" work
    event.preventDefault();
    try { navigate(new URL(el.href, window.location.origin).pathname + new URL(el.href, window.location.origin).search); } catch { /* cross-origin links are left to the browser */ }
    return; // navigate() is a no-op when already on that URL
  }
  if ((el = q("[data-strify-artist]"))) { const pubkey = el.dataset.strifyArtist; if (/^[0-9a-f]{64}$/i.test(pubkey)) navigate(artistPath(pubkey.toLowerCase())); return; }
  if (q("[data-strify-artist-back]")) { navigate("/"); return; }
  if (q("[data-strify-artist-retry]") && S.artist) { void loadArtist(S.artist, { force: true }); return; }
  if (q("[data-strify-artist-more]") && S.artist) { void loadArtist(S.artist, { more: true }); return; }
  if (q("[data-strify-share-status]")) { setShare(!shareOn); return; }
  if ((el = q("[data-strify-goto-lib]"))) { S.tab = "library"; S.libTab = el.dataset.strifyGotoLib; S.view = null; paintBody(); void startDiscovery(); return; }
  if ((el = q("[data-strify-goto]"))) { S.tab = el.dataset.strifyGoto; S.view = null; paintBody(); void startDiscovery(); return; }
  if ((el = q("[data-strify-lib]"))) { S.libTab = el.dataset.strifyLib; S.view = null; paintBody(); void startDiscovery("library"); return; }
  if ((el = q("[data-strify-genre]"))) { S.tab = "search"; S.query = el.dataset.strifyGenre; paintBody(); return; }
  if (q("[data-strify-recent-clear]")) { history.clear(myPubkey()); paintBody(); return; }
  if (q("[data-strify-check-copyright]")) { void onCheckCopyright(); return; }
  if (q("[data-strify-find-more]")) { void loadMine(true, true).then(() => pageActive && paintBody()); paintBody(); return; }
  if ((el = q("[data-strify-edit-track]"))) { const tr = tracksByKey.get(el.dataset.strifyEditTrack); if (tr) openEditTrack(tr); return; }
  if ((el = q("[data-strify-delete-track]"))) { const tr = tracksByKey.get(el.dataset.strifyDeleteTrack); if (tr) confirmDeleteTrack(tr); return; }
  if ((el = q("[data-strify-view]"))) {
    const mode = el.dataset.strifyView === "list" ? "list" : "card";
    if (mode !== S.viewMode) { S.viewMode = mode; saveViewMode(mode); paintBody(); } // same data, same queue; audio untouched
    return;
  }
  if (q("[data-strify-search-clear]")) { S.query = ""; paintBody(); document.querySelector("[data-strify-search]")?.focus(); return; }
  if ((el = q("[data-strify-tab]")) && S.artist) { S.tab = el.dataset.strifyTab; S.view = null; navigate("/"); return; }
  if ((el = q("[data-strify-tab]"))) { S.tab = el.dataset.strifyTab; S.view = null; paintBody(); void startDiscovery(); return; }
  if ((el = q("[data-strify-retry]"))) { const tab = el.dataset.strifyRetry; void startDiscovery(["home", "search", "library", "create"].includes(tab) ? tab : S.tab, true); return; }
  if ((el = q("[data-strify-play-from]"))) { const name = el.dataset.strifyPlayFrom; playList(name, Number(el.dataset.index), labelFor(name)); return; }
  if ((el = q("[data-sp]"))) {
    const a = el.dataset.sp;
    if (a === "toggle") { pauseProfileMusic(); player.toggle(); }
    else if (a === "next") player.next(); else if (a === "prev") player.prev();
    else if (a === "shuffle") player.toggleShuffle(); else if (a === "repeat") player.cycleRepeat();
    else if (a === "mute") player.toggleMute(); else if (a === "queue") openQueue();
    else if (a === "addto") { const cur = player.currentTrack(); if (cur) openAddToPlaylist(cur); }
    else if (a === "zap") { const cur = player.currentTrack(); if (cur) zapTrack(cur); }
    return;
  }
  if (q("[data-strify-queue-close]")) { closeQueue(); return; }
  if ((el = q("[data-strify-queue-at]"))) { player.playAt(Number(el.dataset.strifyQueueAt)); return; }
  if ((el = q("[data-strify-like]"))) { const tr = tracksByKey.get(el.dataset.strifyLike); if (tr) void likeTrack(tr, el); return; }
  if ((el = q("[data-strify-zap]"))) { const tr = tracksByKey.get(el.dataset.strifyZap); if (tr) zapTrack(tr); return; }
  if ((el = q("[data-strify-repost]"))) { const tr = tracksByKey.get(el.dataset.strifyRepost); if (tr) void repostTrack(tr, el); return; }
  if ((el = q("[data-strify-comment]"))) { const tr = tracksByKey.get(el.dataset.strifyComment); if (tr) openComment(tr); return; }
  if ((el = q("[data-strify-addto]"))) { const tr = tracksByKey.get(el.dataset.strifyAddto); if (tr) openAddToPlaylist(tr); return; }
  if (q("[data-strify-signin]")) { host.signIn("Sign in to use strify."); return; }
  if ((el = q("[data-strify-open-playlist]"))) { S.view = el.dataset.strifyOpenPlaylist; paintBody(); return; }
  if (q("[data-strify-back]")) { S.view = null; paintBody(); return; }
  if (q("[data-strify-new-playlist]")) {
    const gate = checkCreate(store?.playlists.length || 0, host.isPremium());
    if (!gate.ok) { host.toast(gate.message); return; }
    openModal(playlistForm(null), { label: "New playlist", onSubmit: (d, w) => submitPlaylistForm(d, w, null) }); return;
  }
  const current = store && S.view ? store.get(S.view) : null;
  if (q("[data-strify-add-songs]") && current) { openSongPicker(current.d); return; }
  if (q("[data-strify-edit-playlist]") && current) { openModal(playlistForm(current), { label: "Edit playlist", onSubmit: (d, w) => submitPlaylistForm(d, w, current) }); return; }
  if (q("[data-strify-share-playlist]") && current) { void sharePlaylist(current); return; }
  if (q("[data-strify-delete-playlist]") && current) {
    openModal(`<form class="strify-form"><h2>Delete “${E(current.name)}”?</h2><p class="strify-note">This publishes a deletion to your relays. Copies already cached elsewhere may linger briefly.</p><p class="strify-status" data-strify-status role="status"></p><div class="strify-form-actions"><button type="button" class="strify-btn" data-strify-close>Cancel</button><button type="submit" class="strify-btn is-danger">Delete</button></div></form>`, { label: "Delete playlist", onSubmit: async (_d, w) => {
      modalStatus(w, "Publishing deletion…");
      try { const r = await store.remove(current.d); if (!r.ok) { modalStatus(w, r.message); return; } closeModal(); S.view = null; host.toast(r.deletionRequested ? "Playlist deleted." : "Playlist deleted (the NIP-09 request wasn't confirmed by a relay)."); paintBody(); }
      catch (error) { modalStatus(w, error?.message || "Couldn't sign the deletion."); }
    } });
    return;
  }
  if (q("[data-strify-play-playlist]") && current) { void playPlaylistRefs(current.tracks, current.name, 0); return; }
  if ((el = q("[data-strify-play-playlist-at]")) && current) { void playPlaylistRefs(current.tracks, current.name, Number(el.dataset.strifyPlayPlaylistAt)); return; }
  if ((el = q("[data-strify-move]")) && current) { void mutate(store.moveTrack(current.d, el.dataset.strifyMove, Number(el.dataset.delta))); return; }
  if ((el = q("[data-strify-remove-track]")) && current) { void mutate(store.removeTrack(current.d, el.dataset.strifyRemoveTrack)); return; }
  const embed = q("[data-strify-playlist]");
  if (embed && (q("[data-strify-embed-play-all]") || q("[data-strify-embed-play]") || q("[data-strify-embed-retry]"))) {
    const data = embedCache.get(embed.dataset.strifyPlaylist);
    if (q("[data-strify-embed-retry]")) { embed.innerHTML = embedHtml({}, null); void loadEmbed({ coord: embed.dataset.strifyPlaylist, pubkey: embed.dataset.strifyPubkey, d: embed.dataset.strifyD, relay: embed.dataset.strifyRelay }, true).then((d) => { if (embed.isConnected) embed.innerHTML = embedHtml({}, d); }); return; }
    if (data?.state === "ok") {
      const tracks = data.tracks.filter(Boolean);
      const startRow = q("[data-strify-embed-play]");
      const clicked = startRow ? data.tracks[Number(startRow.dataset.strifyEmbedPlay)] : tracks[0];
      pauseProfileMusic();
      player.playQueue(tracks, Math.max(0, tracks.indexOf(clicked)), { label: data.playlist.name }); // local queue only; the playlist is never modified
    }
  }
}
async function playPlaylistRefs(refs, name, startRef) {
  const resolved = await resolveRefs(refs);
  const playable = resolved.filter(Boolean);
  if (!playable.length) { host.toast("None of this playlist's tracks could be loaded right now."); return; }
  const target = resolved[startRef];
  pauseProfileMusic();
  player.playQueue(playable, Math.max(0, playable.indexOf(target)), { label: name });
}
async function mutate(promise) {
  try { const r = await promise; if (!r.ok && r.message) host.toast(r.message); }
  catch (error) { host.toast(error?.message || "Couldn't sign or publish."); }
}


// ── Now playing (NIP-38 status) ────────────────────────────────────
// Publisher: opt-in only. While on, the track you play is published as a public, expiring kind 30315 status.
// Reader: feed avatars of authors with a live status get a ring; tapping one shows the track and lets you play it.
const SHARE_KEY = "strify:share-now-playing";
let shareOn = (() => { try { return localStorage.getItem(SHARE_KEY) === "1"; } catch { return false; } })();
let sharedKey = "";         // track key the current published status describes
let shareTimer = null;      // debounce for skips
let pauseTimer = null;      // clear the status if playback stays paused
let shareErrorShown = false;
const live = new Map();     // pubkey -> parsed live status
const statusFetchedAt = new Map(); // pubkey -> ms of the last relay check
const statusQueue = new Set();
let statusTimer = null;

async function publishStatus(template) {
  try {
    const { result } = await host.publish(template);
    if (!result?.accepted?.length) throw new Error("no relay accepted it");
    return true;
  } catch (error) {
    if (!shareErrorShown) { shareErrorShown = true; host.toast(`Couldn't update your now-playing status (${error?.message || "publish failed"}).`); }
    return false;
  }
}
function syncShare() {
  clearTimeout(shareTimer); clearTimeout(pauseTimer);
  const session = host.getSession();
  if (!shareOn || !session) return;
  const st = player.getState();
  const track = player.currentTrack();
  if (track && st.playing) {
    if (sharedKey === track.key) return;
    shareTimer = setTimeout(async () => { // debounce skipping through tracks
      const cur = player.currentTrack();
      if (!cur || !player.getState().playing || !shareOn) return;
      const remaining = Math.max(0, (player.getState().duration || cur.duration || 0) - player.getState().currentTime);
      if (await publishStatus(buildStatusTemplate(cur, { remaining }))) {
        sharedKey = cur.key;
        const me = session.pubkeyHex;
        live.set(me, liveStatuses([{ ...buildStatusTemplate(cur, { remaining }), pubkey: me, id: "0".repeat(64) }]).get(me)); paintRings();
      }
    }, 1500);
  } else if (sharedKey) {
    // Paused or stopped: a short pause keeps the status; a longer one (or stop) clears it.
    pauseTimer = setTimeout(() => void clearStatus(), track ? 60_000 : 0);
  }
}
async function clearStatus() {
  const me = host.getSession()?.pubkeyHex;
  if (!sharedKey && !live.has(me)) return;
  sharedKey = "";
  if (me) live.delete(me);
  paintRings();
  await publishStatus(buildClearStatusTemplate());
}
function setShare(on) {
  if (on && !host.getSession()) { host.signIn("Sign in to share what you're playing."); return; }
  shareOn = on; shareErrorShown = false;
  try { localStorage.setItem(SHARE_KEY, on ? "1" : "0"); } catch { /* preference is optional */ }
  paintShareToggle();
  if (on) { sharedKey = ""; syncShare(); host.toast("Now-playing sharing is on. Friends will see a ring around your avatar while you listen."); }
  else { void clearStatus(); host.toast("Now-playing sharing is off."); }
}
function paintShareToggle() {
  document.querySelectorAll("[data-strify-share-status]").forEach((b) => {
    b.setAttribute("aria-pressed", String(shareOn));
    b.querySelector("span").textContent = shareOn ? "Sharing what I play" : "Share what I play";
  });
}

// Reader
// Avatars that can carry a ring: any element with data-author-pubkey (feed post authors), plus your own composer avatar,
// which has no pubkey in its markup, so it's tagged here from the signed-in session.
function ringAnchors(root = document) {
  const me = host.getSession()?.pubkeyHex;
  const scope = root.nodeType === 1 && root.matches?.(".fs-home-composer-avatar") ? [root] : [];
  for (const el of [...scope, ...(root.querySelectorAll?.(".fs-home-composer-avatar") || [])]) {
    if (me) el.dataset.authorPubkey = me; else delete el.dataset.authorPubkey;
  }
  const found = [...(root.querySelectorAll?.("[data-author-pubkey]") || [])];
  if (root.nodeType === 1 && root.matches?.("[data-author-pubkey]")) found.unshift(root);
  return found;
}
function paintRings(root = document) {
  const now = Math.floor(Date.now() / 1000);
  for (const a of ringAnchors(root)) {
    const status = live.get(a.dataset.authorPubkey);
    const on = !!status && status.expiresAt > now;
    a.classList.toggle("has-now-playing", on);
    if (on) { a.dataset.nowPlaying = "1"; a.setAttribute("aria-label", `${a.dataset.baseLabel ||= a.getAttribute("aria-label") || ""} — listening to ${status.title}. Open now playing`); }
    else if (a.dataset.nowPlaying) { delete a.dataset.nowPlaying; if (a.dataset.baseLabel) a.setAttribute("aria-label", a.dataset.baseLabel); }
  }
}
function queueStatusChecks(root = document, { stale = 90_000 } = {}) {
  const now = Date.now();
  for (const a of ringAnchors(root)) {
    const pk = a.dataset.authorPubkey;
    if (HEX64.test(pk || "") && now - (statusFetchedAt.get(pk) || 0) > stale) statusQueue.add(pk);
  }
  if (statusQueue.size && !statusTimer) statusTimer = setTimeout(flushStatusChecks, 500); // batch a screenful of authors into one query
}
async function flushStatusChecks() {
  statusTimer = null;
  const authors = [...statusQueue].slice(0, 60);
  authors.forEach((pk) => statusQueue.delete(pk));
  if (!authors.length) return;
  authors.forEach((pk) => statusFetchedAt.set(pk, Date.now()));
  try {
    const events = await net.fetch([{ kinds: [STATUS_KIND], authors, "#d": [STATUS_D], limit: authors.length * 2 }], { urls: userRelays().slice(0, 4), timeout: 4000 });
    const found = liveStatuses(events);
    for (const pk of authors) { if (found.has(pk)) live.set(pk, found.get(pk)); else if (pk !== host.getSession()?.pubkeyHex || !sharedKey) live.delete(pk); }
    paintRings();
  } catch { /* rings are best-effort; feeds work without them */ }
  if (statusQueue.size) statusTimer = setTimeout(flushStatusChecks, 500);
}

async function openNowPlaying(pubkey) {
  const status = live.get(pubkey);
  if (!status) return;
  const profile = profiles.get(pubkey);
  const name = profile?.name || shorten(npubFromHex(pubkey), 8, 4);
  const wrap = openModal(`<div class="strify-form strify-nowplaying"><p class="strify-eyebrow">${strifyMark("strify-mark is-small")}Listening now</p>
    <div class="strify-np-body">${coverHtml(status.cover)}<div><strong>${E(status.title)}</strong>${status.artist ? `<span>${E(status.artist)}</span>` : ""}<small>${E(name)} · <span data-np-ago></span></small></div></div>
    <p class="strify-status" data-strify-status role="status"></p>
    <div class="strify-form-actions"><a class="strify-btn" href="/p/${E(npubFromHex(pubkey))}" data-route-link data-strify-close>${icon("fa-user")} View profile</a><button type="button" class="strify-btn is-primary" data-np-play>${icon("fa-play")} Play</button></div></div>`, { label: `${name} is listening to ${status.title}` });
  const ago = wrap.querySelector("[data-np-ago]");
  if (ago) ago.textContent = status.createdAt ? `started ${timeAgo(status.createdAt)}` : "now";
  wrap.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-np-play]"); if (!btn) return;
    btn.disabled = true; modalStatus(wrap, "Finding the track…");
    try {
      let track = null;
      const ref = status.trackRef;
      if (ref?.id) track = tracksByKey.get(ref.id) || (await discover([{ ids: [ref.id] }], userRelays())).tracks[0] || null;
      else if (ref?.d) track = tracksByKey.get(`31337:${ref.pubkey}:${ref.d}`) || (await discover([{ kinds: [AUDIO_TRACK_KIND], authors: [ref.pubkey], "#d": [ref.d] }], userRelays())).tracks[0] || null;
      if (!track && status.url && classifyMediaUrl(status.url).type === "audio") {
        // The track event isn't on your relays; play the audio URL they published. Social actions need the real event, so they're unavailable.
        track = { key: `status:${status.eventId}`, eventId: "", pubkey, kind: 1808, d: "", createdAt: status.createdAt, url: status.url, title: status.title, artist: status.artist, album: "", genre: "", duration: 0, coverArt: status.cover };
      }
      if (!track) { modalStatus(wrap, "That track couldn't be found on your relays."); btn.disabled = false; return; }
      closeModal(); pauseProfileMusic(); player.playQueue([track], 0, { label: `${name}'s now playing` });
    } catch (error) { modalStatus(wrap, error?.message || "Couldn't load the track."); btn.disabled = false; }
  });
}

export function initStrify(hostApi) {
  host = hostApi;
  ensureMini();
  player.setPlayGuard(() => pauseProfileMusic());
  setProfileAutoplayBlocker(() => player.isStrifyPlaying());
  setProfilePlayHook(() => player.pauseStrify());
  player.subscribe(syncUi);
  player.subscribeTime(syncTime);
  document.addEventListener("click", onClick);
  // Capture phase: a ringed avatar opens the now-playing card instead of navigating (like tapping a story ring).
  document.addEventListener("click", (event) => {
    const a = event.target.closest?.(".has-now-playing[data-author-pubkey]");
    if (!a || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation();
    void openNowPlaying(a.dataset.authorPubkey);
  }, true);
  player.subscribe(syncShare);
  setInterval(() => { if (document.visibilityState === "visible") { queueStatusChecks(document, { stale: 60_000 }); paintRings(); } }, 45_000);
  let searchTimer = null;
  document.addEventListener("input", (e) => {
    const search = e.target.closest?.("[data-strify-search]");
    if (search) { // filters the already-loaded catalog locally: no relay query per keystroke, playback is untouched
      S.query = search.value.slice(0, 120);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { if (pageActive) paintBody(); }, 120);
      return;
    }
    const seek = e.target.closest?.("[data-sp-seek]"); if (seek) { rangeDragging.add(seek); player.seek(Number(seek.value)); clearTimeout(seek._t); seek._t = setTimeout(() => rangeDragging.delete(seek), 400); }
    const vol = e.target.closest?.("[data-sp-volume]"); if (vol) player.setVolume(Number(vol.value));
  });
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) for (const node of m.addedNodes) if (node.nodeType === 1) {
      if (node.matches?.("[data-strify-playlist]")) scanEmbeds(node.parentNode); else scanEmbeds(node);
      paintRings(node); queueStatusChecks(node);
    }
  });
  observer.observe(document.getElementById("mainContent") || document.body, { childList: true, subtree: true });
  scanEmbeds();
  queueStatusChecks(); paintRings(); paintShareToggle();
  window.addEventListener("strify:session", () => { if (pageActive) { syncSessionStore(); S.create.dirtyRender = true; paintBody(); void startDiscovery(S.tab, true); } });
  window.addEventListener("strify:relays", () => { if (pageActive) void startDiscovery(S.tab, true); });
  window.addEventListener("strify:premium", () => { if (pageActive && onPlaylists()) paintBody(); });
  // Create tab: file pickers, invalidating a stale copyright check when the title/artist change, and the submit.
  document.addEventListener("change", (e) => {
    const audio = e.target.closest?.("[data-strify-audio-file]"); if (audio) { void onAudioChosen(audio); return; }
    const cover = e.target.closest?.("[data-strify-cover-file]"); if (cover) onCoverChosen(cover);
  });
  document.addEventListener("submit", (e) => { const form = e.target.closest?.("[data-strify-create-form]"); if (form) { e.preventDefault(); void submitCreate(form); } });
  document.addEventListener("input", (e) => {
    const field = e.target.closest?.("[data-strify-create-form] [name=title], [data-strify-create-form] [name=artist]");
    if (field && S.create.check) { S.create.check = null; S.create.checkKey = ""; const out = document.querySelector("[data-strify-check-result]"); if (out) out.innerHTML = ""; }
  });
  // "Recently played" is recorded on this device only whenever the current track changes.
  let lastRecorded = "";
  player.subscribe(() => { const cur = player.currentTrack(); if (!cur || cur.key === lastRecorded) return; lastRecorded = cur.key; history.record(cur, myPubkey()); });
  syncUi();
}
