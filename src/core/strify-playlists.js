// Kind 30078 playlists. Nostr events are the source of truth; localStorage is only a cache.
import { PLAYLIST_KIND, PLAYLIST_D_PREFIX, PLAYLIST_T_TAG, PLAYLIST_SCHEMA_VERSION, PLAYLIST_FIELDS, DELETION_KIND, limitsFor } from "./strify-config.js";
import { safeHttpsUrl, trackKeyOf } from "./strify-tracks.js";

const HEX64 = /^[0-9a-f]{64}$/i;
export const newPlaylistId = () => {
  const bytes = new Uint8Array(8);
  (globalThis.crypto || { getRandomValues: (b) => b.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};
export const playlistDTag = (id) => `${PLAYLIST_D_PREFIX}${id}`;
export const isPlaylistDTag = (d) => typeof d === "string" && d.startsWith(PLAYLIST_D_PREFIX) && d.length > PLAYLIST_D_PREFIX.length;
export const playlistCoordinate = (pubkey, d) => `${PLAYLIST_KIND}:${pubkey}:${d}`;
export const refKey = (ref) => trackKeyOf({ kind: ref.kind, pubkey: ref.pubkey, d: ref.d, eventId: ref.id });

function cleanRef(ref) {
  if (!ref || !HEX64.test(ref.id || "") || !HEX64.test(ref.pubkey || "") || !Number.isInteger(ref.kind)) return null;
  const out = { id: ref.id.toLowerCase(), kind: ref.kind, pubkey: ref.pubkey.toLowerCase() };
  if (typeof ref.d === "string" && ref.d && ref.d.length <= 200) out.d = ref.d;
  return out;
}

export function sanitizeMeta({ name, description, cover }) {
  return {
    name: String(name ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, PLAYLIST_FIELDS.name),
    description: String(description ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, PLAYLIST_FIELDS.description),
    cover: safeHttpsUrl(cover),
  };
}

/** Unsigned event template for a playlist (sign/publish with Friendstr's existing signer). */
export function buildPlaylistTemplate(playlist, { createdAt } = {}) {
  const content = JSON.stringify({
    v: PLAYLIST_SCHEMA_VERSION, app: "strify",
    name: playlist.name, description: playlist.description || "", cover: playlist.cover || "",
    tracks: playlist.tracks.map(cleanRef).filter(Boolean),
    createdAt: playlist.createdAt, updatedAt: playlist.updatedAt,
  });
  return { kind: PLAYLIST_KIND, tags: [["d", playlist.d], ["t", PLAYLIST_T_TAG], ["title", playlist.name], ["client", "strify"]], content, ...(createdAt ? { created_at: createdAt } : {}) };
}

export function buildTombstoneTemplate(playlist, createdAt) {
  return { kind: PLAYLIST_KIND, tags: [["d", playlist.d], ["t", PLAYLIST_T_TAG]], content: JSON.stringify({ v: PLAYLIST_SCHEMA_VERSION, app: "strify", deleted: true }), ...(createdAt ? { created_at: createdAt } : {}) };
}

export function buildDeletionTemplate(playlist, ownerPubkey, latestEventId) {
  const tags = [["a", playlistCoordinate(ownerPubkey, playlist.d)], ["k", String(PLAYLIST_KIND)]];
  if (HEX64.test(latestEventId || "")) tags.push(["e", latestEventId]);
  return { kind: DELETION_KIND, tags, content: "strify playlist deleted" };
}

/** Returns a playlist, { deleted: true, d, ... } for a tombstone, or null when the event isn't a strify playlist. */
export function parsePlaylistEvent(event) {
  if (!event || event.kind !== PLAYLIST_KIND || !HEX64.test(event.pubkey || "")) return null;
  const d = (event.tags || []).find((t) => t?.[0] === "d")?.[1];
  if (!isPlaylistDTag(d)) return null;
  let data;
  try { data = JSON.parse(event.content); } catch { return null; }
  if (!data || typeof data !== "object" || data.app !== "strify") return null;
  const base = { d, pubkey: event.pubkey.toLowerCase(), eventId: event.id, createdAtEvent: Number(event.created_at) || 0 };
  if (data.deleted === true) return { ...base, deleted: true };
  if (!Array.isArray(data.tracks)) return null;
  const meta = sanitizeMeta(data);
  const seen = new Set();
  const tracks = [];
  for (const raw of data.tracks) {
    const ref = cleanRef(raw);
    if (!ref || seen.has(refKey(ref))) continue;
    seen.add(refKey(ref));
    tracks.push(ref);
  }
  return { ...base, ...meta, name: meta.name || "Untitled playlist", tracks, createdAt: Number(data.createdAt) || base.createdAtEvent, updatedAt: Number(data.updatedAt) || base.createdAtEvent };
}

/** Newest version per d-tag wins; a deletion request or tombstone newer than the playlist removes it. */
export function reducePlaylists(events, deletionEvents = []) {
  const deletedAt = new Map();
  for (const del of deletionEvents) {
    for (const tag of del.tags || []) {
      if (tag[0] !== "a") continue;
      const [kind, pubkey, ...rest] = String(tag[1] || "").split(":");
      if (Number(kind) === PLAYLIST_KIND && pubkey === del.pubkey) {
        const d = rest.join(":");
        deletedAt.set(d, Math.max(deletedAt.get(d) || 0, del.created_at || 0));
      }
    }
  }
  const latest = new Map();
  for (const event of events) {
    const parsed = parsePlaylistEvent(event);
    if (!parsed) continue;
    const prior = latest.get(parsed.d);
    if (!prior || parsed.createdAtEvent > prior.createdAtEvent || (parsed.createdAtEvent === prior.createdAtEvent && parsed.eventId < prior.eventId)) latest.set(parsed.d, parsed);
  }
  return [...latest.values()].filter((p) => !p.deleted && !((deletedAt.get(p.d) || 0) >= p.createdAtEvent)).sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Tier rules (used by the UI and by PlaylistStore, so they can't drift apart) ──
export function checkCreate(count, isPremium) {
  const { maxPlaylists } = limitsFor(isPremium);
  return count >= maxPlaylists
    ? { ok: false, code: "playlist-limit", message: isPremium ? `You've reached the Premium limit of ${maxPlaylists} playlists. Delete one to make room.` : `Free accounts can have ${maxPlaylists} playlist. Upgrade to Premium for up to ${limitsFor(true).maxPlaylists}.` }
    : { ok: true };
}
export function checkAddTrack(playlist, ref, isPremium) {
  if (playlist.tracks.some((t) => refKey(t) === refKey(ref))) return { ok: false, code: "duplicate", message: "That track is already in this playlist." };
  const { maxTracksPerPlaylist } = limitsFor(isPremium);
  if (playlist.tracks.length >= maxTracksPerPlaylist) return { ok: false, code: "track-limit", message: isPremium ? `Playlists hold up to ${maxTracksPerPlaylist} tracks on Premium.` : `Free playlists hold up to ${maxTracksPerPlaylist} tracks. Upgrade to Premium for ${limitsFor(true).maxTracksPerPlaylist}.` };
  return { ok: true };
}

/**
 * Owns the signed-in user's playlists. Dependencies are injected:
 *   fetchEvents(filters) -> events        read from relays (throws if none reachable)
 *   publish(template)   -> { signed, result: { accepted: [] } }   sign + publish with Friendstr's signer
 *   isPremium()         -> boolean        real membership status
 * A change is only applied locally after at least one relay accepted it.
 */
export class PlaylistStore {
  constructor({ pubkey, fetchEvents, publish, isPremium, storage = globalThis.localStorage }) {
    Object.assign(this, { pubkey, fetchEvents, publish, isPremium, storage });
    this.playlists = [];
    this.unsynced = new Set();
    this.status = "idle"; // idle | loading | ready | error
    this.error = "";
    this.listeners = new Set();
    this.chain = Promise.resolve();
    this.readCache();
  }
  get cacheKey() { return `strify:playlists:${this.pubkey}`; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => fn(this)); }
  readCache() {
    try {
      const cached = JSON.parse(this.storage?.getItem(this.cacheKey) || "[]");
      if (Array.isArray(cached)) { this.playlists = cached.filter((p) => isPlaylistDTag(p?.d) && Array.isArray(p.tracks)); this.unsynced = new Set(this.playlists.map((p) => p.d)); }
    } catch { /* ignore a corrupt cache */ }
  }
  writeCache() { try { this.storage?.setItem(this.cacheKey, JSON.stringify(this.playlists)); } catch { /* cache only */ } }
  get(d) { return this.playlists.find((p) => p.d === d) || null; }

  async load() {
    this.status = "loading"; this.error = ""; this.emit();
    try {
      const [events, deletions] = await Promise.all([
        this.fetchEvents([{ kinds: [PLAYLIST_KIND], authors: [this.pubkey], "#t": [PLAYLIST_T_TAG], limit: 200 }]),
        this.fetchEvents([{ kinds: [DELETION_KIND], authors: [this.pubkey], "#k": [String(PLAYLIST_KIND)], limit: 200 }]).catch(() => []),
      ]);
      const remote = reducePlaylists(events.filter((e) => e.pubkey === this.pubkey), deletions);
      const remoteByD = new Map(remote.map((p) => [p.d, p]));
      const deletedDs = new Set(events.map(parsePlaylistEvent).filter((p) => p?.deleted).map((p) => p.d));
      // Relay copy is authoritative. A cached playlist no relay returned is kept but flagged, never silently trusted.
      const kept = this.playlists.filter((p) => !remoteByD.has(p.d) && !deletedDs.has(p.d));
      this.unsynced = new Set(kept.map((p) => p.d));
      this.playlists = [...remote, ...kept].sort((a, b) => b.updatedAt - a.updatedAt);
      this.status = "ready"; this.writeCache();
    } catch (error) {
      this.status = "error"; this.error = error?.message || "Couldn't reach your relays.";
    }
    this.emit();
  }

  serial(task) { const run = this.chain.then(task, task); this.chain = run.catch(() => {}); return run; }

  async commit(playlist, template) {
    const { signed, result } = await this.publish(template);
    if (!result?.accepted?.length) return { ok: false, code: "publish-failed", message: `No relay accepted the change${result?.rejected?.length ? ` (${result.rejected[0].message || "rejected"})` : result?.pending?.length ? " (timed out)" : ""}. Nothing was saved.` };
    const saved = { ...playlist, eventId: signed.id, createdAtEvent: signed.created_at };
    this.playlists = [saved, ...this.playlists.filter((p) => p.d !== saved.d)].sort((a, b) => b.updatedAt - a.updatedAt);
    this.unsynced.delete(saved.d); this.writeCache(); this.emit();
    return { ok: true, playlist: saved, relays: result.accepted.length };
  }

  nextCreatedAt(prev) { return Math.max(Math.floor(Date.now() / 1000), (prev?.createdAtEvent || 0) + 1); }

  create({ name, description, cover, firstTrack } = {}) {
    return this.serial(async () => {
      const gate = checkCreate(this.playlists.length, this.isPremium());
      if (!gate.ok) return gate;
      const meta = sanitizeMeta({ name, description, cover });
      if (!meta.name) return { ok: false, code: "invalid", message: "Give the playlist a name." };
      const tracks = [];
      if (firstTrack) { const ref = cleanRef(firstTrack); if (ref) tracks.push(ref); }
      const now = Math.floor(Date.now() / 1000);
      const playlist = { d: playlistDTag(newPlaylistId()), pubkey: this.pubkey, ...meta, tracks, createdAt: now, updatedAt: now };
      return this.commit(playlist, buildPlaylistTemplate(playlist, { createdAt: now }));
    });
  }

  update(d, mutate) {
    return this.serial(async () => {
      const current = this.get(d);
      if (!current) return { ok: false, code: "missing", message: "That playlist no longer exists." };
      const draft = mutate({ ...current, tracks: [...current.tracks] });
      if (draft?.ok === false) return draft;
      const next = { ...draft, updatedAt: Math.floor(Date.now() / 1000) };
      return this.commit(next, buildPlaylistTemplate(next, { createdAt: this.nextCreatedAt(current) }));
    });
  }

  edit(d, fields) {
    return this.update(d, (p) => {
      const meta = sanitizeMeta({ name: fields.name ?? p.name, description: fields.description ?? p.description, cover: "cover" in fields ? fields.cover : p.cover });
      if (!meta.name) return { ok: false, code: "invalid", message: "Give the playlist a name." };
      if ("cover" in fields && fields.cover && !meta.cover) return { ok: false, code: "invalid", message: "The cover must be an https image URL." };
      return { ...p, ...meta };
    });
  }
  addTrack(d, trackRefIn) {
    const ref = cleanRef(trackRefIn);
    return this.update(d, (p) => {
      if (!ref) return { ok: false, code: "invalid", message: "That track can't be referenced." };
      const gate = checkAddTrack(p, ref, this.isPremium());
      return gate.ok ? { ...p, tracks: [...p.tracks, ref] } : gate;
    });
  }
  removeTrack(d, key) { return this.update(d, (p) => ({ ...p, tracks: p.tracks.filter((t) => refKey(t) !== key) })); }
  moveTrack(d, key, delta) {
    return this.update(d, (p) => {
      const i = p.tracks.findIndex((t) => refKey(t) === key); const j = i + delta;
      if (i < 0 || j < 0 || j >= p.tracks.length) return { ok: false, code: "noop", message: "" };
      const tracks = [...p.tracks]; [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
      return { ...p, tracks };
    });
  }

  /** Tombstone (replaceable event, same d) first so every relay serves "deleted", then a NIP-09 request for relays that honour it. */
  remove(d) {
    return this.serial(async () => {
      const current = this.get(d);
      if (!current) return { ok: false, code: "missing", message: "That playlist no longer exists." };
      const tomb = await this.publish(buildTombstoneTemplate(current, this.nextCreatedAt(current)));
      if (!tomb.result?.accepted?.length) return { ok: false, code: "publish-failed", message: "No relay accepted the deletion. The playlist was not deleted." };
      let requested = true;
      try { const del = await this.publish(buildDeletionTemplate(current, this.pubkey, current.eventId)); requested = !!del.result?.accepted?.length; } catch { requested = false; }
      this.playlists = this.playlists.filter((p) => p.d !== d); this.unsynced.delete(d); this.writeCache(); this.emit();
      return { ok: true, deletionRequested: requested };
    });
  }
}

/** Latest public version of any user's playlist from a fetch function (used by shared-post previews). */
export async function fetchPlaylistVersion(fetchEvents, pubkey, d) {
  const events = await fetchEvents([{ kinds: [PLAYLIST_KIND], authors: [pubkey], "#d": [d], limit: 5 }]);
  const parsed = events.filter((e) => e.pubkey === pubkey).map(parsePlaylistEvent).filter(Boolean).sort((a, b) => b.createdAtEvent - a.createdAtEvent);
  if (!parsed.length) return { state: "missing" };
  return parsed[0].deleted ? { state: "deleted" } : { state: "ok", playlist: parsed[0] };
}
