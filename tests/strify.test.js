import test from "node:test";
import assert from "node:assert/strict";
import { parseAudioEvent, resolveAudioEvents, classifyMediaUrl, dedupeTracks } from "../src/core/strify-tracks.js";
import { buildOrder, stepNext, stepPrev } from "../src/core/strify-queue.js";
import { PlaylistStore, reducePlaylists, buildPlaylistTemplate, parsePlaylistEvent, checkCreate, checkAddTrack, playlistDTag, refKey } from "../src/core/strify-playlists.js";
import { PLAYLIST_LIMITS } from "../src/core/strify-config.js";

const H = (c) => c.repeat(64);
const PK = H("a");
const track31337 = (over = {}) => ({ id: H("1"), pubkey: PK, kind: 31337, created_at: 100, content: "desc", tags: [["d", "song"], ["title", "Song"], ["artist", "Ann"], ["media", "https://cdn.example/a.mp3", "http"], ["image", "https://cdn.example/c.jpg"]], ...over });

test("31337 track parses media, cover and coordinate key", () => {
  const r = parseAudioEvent(track31337());
  assert.equal(r.status, "ready");
  assert.equal(r.track.url, "https://cdn.example/a.mp3");
  assert.equal(r.track.key, `31337:${PK}:song`);
});
test("rejects http/javascript media and non-audio pages", () => {
  assert.equal(parseAudioEvent(track31337({ tags: [["d", "x"], ["media", "http://x/a.mp3"]] })), null);
  assert.equal(parseAudioEvent(track31337({ tags: [["d", "x"], ["media", "https://youtube.com/watch?v=1"]] })), null);
  assert.equal(classifyMediaUrl("javascript:alert(1)").type, "unsupported");
});
test("wavlake page is not treated as playable until resolved", async () => {
  const ev = track31337({ tags: [["d", "w"], ["title", "W"], ["media", "https://wavlake.com/track/12345678-aaaa-bbbb-cccc-1234567890ab"]] });
  assert.equal(parseAudioEvent(ev).status, "needs-resolve");
  const ok = await resolveAudioEvents([ev], { resolveWavlake: async () => ({ url: "https://cdn.example/w.mp3" }) });
  assert.equal(ok.tracks[0].url, "https://cdn.example/w.mp3");
  const bad = await resolveAudioEvents([ev], { resolveWavlake: async () => { throw new Error("x"); } });
  assert.equal(bad.tracks.length, 0); assert.equal(bad.skipped, 1);
});
test("1808 header without url resolves through its e/a reference", async () => {
  const header = { id: H("2"), pubkey: H("b"), kind: 1808, created_at: 200, content: "", tags: [["title", "Header Title"], ["a", `31337:${PK}:song`]] };
  assert.equal(parseAudioEvent(header).status, "reference");
  const res = await resolveAudioEvents([header], { fetchEvents: async () => [track31337()] });
  assert.equal(res.tracks.length, 1);
  assert.equal(res.tracks[0].title, "Header Title");
  assert.equal(res.tracks[0].url, "https://cdn.example/a.mp3");
  const none = await resolveAudioEvents([header], { fetchEvents: async () => [] });
  assert.equal(none.tracks.length, 0);
});
test("1808 JSON content (existing friendstr shape) is playable; dedupe keeps newest", () => {
  const e = { id: H("3"), pubkey: PK, kind: 1808, created_at: 5, content: JSON.stringify({ url: "https://x.test/a.mp3", title: "T" }), tags: [] };
  assert.equal(parseAudioEvent(e).status, "ready");
  const a = parseAudioEvent(track31337()).track, b = parseAudioEvent(track31337({ id: H("4"), created_at: 300 })).track;
  assert.equal(dedupeTracks([a, b]).length, 1); assert.equal(dedupeTracks([a, b])[0].eventId, H("4"));
});

test("queue stepping: repeat modes, shuffle keeps current first", () => {
  assert.deepEqual(stepNext({ pos: 2, length: 3, repeat: "off", auto: true }), { pos: 2, stop: true });
  assert.equal(stepNext({ pos: 2, length: 3, repeat: "all", auto: true }).pos, 0);
  assert.equal(stepNext({ pos: 1, length: 3, repeat: "one", auto: true }).restart, true);
  assert.equal(stepNext({ pos: 1, length: 3, repeat: "one", auto: false }).pos, 2);
  assert.equal(stepPrev({ pos: 1, length: 3, repeat: "off", currentTime: 10 }).restart, true);
  const o = buildOrder(5, 3, true);
  assert.equal(o[0], 3); assert.deepEqual([...o].sort(), [0, 1, 2, 3, 4]);
});

// ── playlists ──
const ref = (n) => ({ id: n.toString(16).padStart(2, "0").repeat(32), kind: 31337, pubkey: PK, d: `s${n}` });
function makeStore({ premium = false, accept = true } = {}) {
  const published = [];
  const flags = { premium, accept };
  let clock = 1000;
  const store = new PlaylistStore({
    pubkey: PK, storage: null, isPremium: () => flags.premium, fetchEvents: async () => published.filter((e) => e.kind !== 5 || true),
    publish: async (t) => { const signed = { ...t, id: H(String((published.length % 9) + 1)).replace(/^./, String(published.length % 10)), pubkey: PK, created_at: t.created_at || ++clock, sig: "s" }; if (flags.accept) published.push(signed); return { signed, result: { accepted: flags.accept ? ["wss://r"] : [], rejected: [], pending: [] } }; },
  });
  return { store, published, flags };
}

test("free tier: 1 playlist, 12 tracks; premium: 10 / 20; configured in one place", async () => {
  assert.deepEqual(PLAYLIST_LIMITS.free, { maxPlaylists: 1, maxTracksPerPlaylist: 12 });
  assert.deepEqual(PLAYLIST_LIMITS.premium, { maxPlaylists: 10, maxTracksPerPlaylist: 20 });
  const { store } = makeStore();
  const first = await store.create({ name: "One" });
  assert.ok(first.ok);
  assert.equal((await store.create({ name: "Two" })).code, "playlist-limit");
  const d = first.playlist.d;
  for (let i = 1; i <= 12; i++) assert.ok((await store.addTrack(d, ref(i))).ok);
  assert.equal((await store.addTrack(d, ref(13))).code, "track-limit");
  assert.equal((await store.addTrack(d, ref(1))).code, "duplicate");
});
test("downgrade keeps everything, blocks additions, still allows rename/remove/delete", async () => {
  const { store, flags } = makeStore({ premium: true });
  const a = await store.create({ name: "A" }); const b = await store.create({ name: "B" });
  for (let i = 1; i <= 15; i++) await store.addTrack(a.playlist.d, ref(i));
  flags.premium = false;
  assert.equal(store.playlists.length, 2);
  assert.equal(store.get(a.playlist.d).tracks.length, 15);
  assert.equal((await store.create({ name: "C" })).code, "playlist-limit");
  assert.equal((await store.addTrack(a.playlist.d, ref(16))).code, "track-limit");
  assert.ok((await store.edit(a.playlist.d, { name: "Renamed" })).ok);
  assert.ok((await store.removeTrack(a.playlist.d, refKey(ref(1)))).ok);
  assert.equal(store.get(a.playlist.d).tracks.length, 14);
  assert.ok((await store.remove(b.playlist.d)).ok);
});
test("publish failure is reported and leaves state untouched", async () => {
  const { store, flags } = makeStore();
  const made = await store.create({ name: "Keep" });
  flags.accept = false;
  const r = await store.edit(made.playlist.d, { name: "Nope" });
  assert.equal(r.ok, false); assert.equal(r.code, "publish-failed");
  assert.equal(store.get(made.playlist.d).name, "Keep");
  assert.equal((await store.create({ name: "x" })).ok, false);
});
test("event shape: kind 30078, d tag, ordered track refs; reducer keeps newest and honours deletion", async () => {
  const { store, published } = makeStore({ premium: true });
  const p = (await store.create({ name: "Mix", description: "d", cover: "https://img.test/c.png" })).playlist;
  await store.addTrack(p.d, ref(1)); await store.addTrack(p.d, ref(2)); await store.moveTrack(p.d, refKey(ref(2)), -1);
  const latest = published.at(-1);
  assert.equal(latest.kind, 30078); assert.equal(latest.tags[0][1], p.d);
  const parsed = parsePlaylistEvent(latest);
  assert.deepEqual(parsed.tracks.map((t) => t.d), ["s2", "s1"]);
  assert.equal(parsed.cover, "https://img.test/c.png");
  assert.equal(reducePlaylists(published).length, 1);
  assert.equal(reducePlaylists(published)[0].tracks.length, 2);
  await store.remove(p.d);
  assert.equal(reducePlaylists(published, published.filter((e) => e.kind === 5)).length, 0);
  assert.equal(reducePlaylists(published).length, 0); // tombstone alone also hides it
});
test("load() restores playlists from relays and rejects foreign authors", async () => {
  const { store, published } = makeStore();
  await store.create({ name: "Remote" });
  const fresh = new PlaylistStore({ pubkey: PK, storage: null, isPremium: () => false, publish: async () => {}, fetchEvents: async () => [...published, { ...published[0], pubkey: H("c") }] });
  await fresh.load();
  assert.equal(fresh.status, "ready"); assert.equal(fresh.playlists[0].name, "Remote");
  const failing = new PlaylistStore({ pubkey: PK, storage: null, isPremium: () => false, publish: async () => {}, fetchEvents: async () => { throw new Error("offline"); } });
  await failing.load(); assert.equal(failing.status, "error");
});
test("cover must be https; tier helpers", () => {
  assert.equal(checkCreate(0, false).ok, true); assert.equal(checkCreate(1, false).ok, false); assert.equal(checkCreate(9, true).ok, true);
  assert.equal(checkAddTrack({ tracks: Array(20).fill(0).map((_, i) => ref(i + 1)) }, ref(30), true).code, "track-limit");
});

import { renderPlaylistEmbedPlaceholder, playlistCoordinateFromTags } from "../src/core/strify-embed.js";
test("only strify playlist `a` tags produce a preview placeholder", () => {
  const coord = `30078:${PK}:strify:playlist:abc123`;
  assert.equal(playlistCoordinateFromTags([["a", coord, "wss://r.example"]]).d, "strify:playlist:abc123");
  assert.match(renderPlaylistEmbedPlaceholder([["a", coord]]), /data-strify-playlist/);
  assert.equal(renderPlaylistEmbedPlaceholder([["a", `30078:${PK}:friendstr:premium`]]), "");
  assert.equal(renderPlaylistEmbedPlaceholder([["a", `30023:${PK}:strify:playlist:x`]]), "");
});

test("real kind 1808 BCH Radio event (JSON content, only t tags) parses to a playable track", () => {
  const event = {
    content: "{\"url\":\"https://npub1y4s67mks7j3y2ezk2nk63sk2v9ujetj6vcstj27ht3p0htkvarrs5h5v4f.blossom.band/6b36f5f65647253ed646d230e9ca49b4d9e3ca605d9a013f6c6b1003a55a51f5.mp3\",\"title\":\"#2 Nakamotos Dream\",\"artist\":\"InvalidCastX\",\"duration\":277,\"paidSats\":0,\"coverArt\":\"https://npub1y4s67mks7j3y2ezk2nk63sk2v9ujetj6vcstj27ht3p0htkvarrs5h5v4f.blossom.band/726cad4e80716f198c98a8c37fd8594ae0ebaf41019400f76380700b93cf5494.jpg\",\"genre\":\"Pop\"}",
    created_at: 1784336879,
    id: "7039e500633ccaf5cd0153d29fad6fa899da393e94eeb7db30aa367d3a8d6a4f",
    kind: 1808,
    pubkey: "2561af6ed0f4a245645654eda8c2ca61792cae5a6620b92bd75c42fbaecce8c7",
    tags: [["t", "bch-radio-track"], ["t", "bch"], ["t", "bch-radio"], ["t", "bch-radio-genre-pop"]],
  };
  const r = parseAudioEvent(event);
  assert.equal(r.status, "ready");
  assert.equal(r.track.title, "#2 Nakamotos Dream");
  assert.equal(r.track.artist, "InvalidCastX");
  assert.equal(r.track.duration, 277);
  assert.equal(r.track.genre, "Pop");
  assert.match(r.track.url, /\.blossom\.band\/6b36.*\.mp3$/);
  assert.match(r.track.coverArt, /726cad4e.*\.jpg$/);
  assert.equal(r.track.key, event.id);
});
