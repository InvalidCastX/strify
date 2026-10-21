import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTrack, toUnified, parseAlbum, parseArtist, parsePlaylist, parseSocialNote, zapSats, countZaps, homePool, buildSections, buildExtraSections, seededShuffle, greetingFor } from "../src/core/strify-home.js";
import { resolveAudioEvents } from "../src/core/strify-tracks.js";

const H = (n) => n.toString(16).padStart(64, "0");
const A = H(5), B = H(6);
const NOW = 1_800_000_000;
const ev = (n, kind, tags = [], content = "", pubkey = A, created = NOW - 100) => ({ id: H(n), pubkey, kind, created_at: created, sig: "s", tags, content });
const t30440 = (n, d, extra = [], pubkey = A, created = NOW - 100) => ev(n, 30440, [["d", d], ["title", `Song ${d}`], ["artist", "The Band"], ["album", "LP"], ["genre", "Pop"], ["duration", "200"], ["url", `https://m.test/${d}.mp3`], ["image", `https://m.test/${d}.jpg`], ...extra], "", pubkey, created);
const t1808 = (n, created = NOW - 100) => ev(n, 1808, [], JSON.stringify({ url: `https://m.test/${n}.mp3`, title: `Legacy ${n}`, artist: "Old Band", duration: 180, coverArt: `https://m.test/${n}.jpg`, genre: "Rock" }), A, created);

test("normalizeTrack: 30440 uses the d tag as id, 1808 uses the event id; both carry the unified fields", () => {
  const a = normalizeTrack(t30440(1, "my-song"));
  assert.equal(a.id, "my-song"); assert.equal(a.sourceKind, 30440);
  assert.equal(a.audioUrl, "https://m.test/my-song.mp3"); assert.equal(a.imageUrl, "https://m.test/my-song.jpg");
  assert.deepEqual([a.title, a.artist, a.album, a.duration, a.pubkey], ["Song my-song", "The Band", "LP", 200, A]);
  assert.equal(a.key, `30440:${A}:my-song`, "key stays unique per author even if two authors reuse a d tag");
  assert.equal(a.url, a.audioUrl, "player fields are kept");
  const b = normalizeTrack(t1808(2));
  assert.equal(b.id, H(2)); assert.equal(b.sourceKind, 1808); assert.equal(b.audioUrl, "https://m.test/2.mp3");
  assert.equal(normalizeTrack(ev(3, 30440, [["d", "x"], ["title", "No audio"]])), null);
  assert.equal(normalizeTrack(ev(4, 7)), null);
});

test("30440 tracks resolve through the same pipeline as 1808 (and 30440 headers can be referenced by a tags)", async () => {
  const { tracks } = await resolveAudioEvents([t30440(1, "a"), t1808(2), ev(5, 30440, [["d", "dup"]]), t30440(3, "a", [], A, NOW)]);
  assert.equal(tracks.length, 2, "newest version of an addressable track wins");
  tracks.map(toUnified);
  assert.ok(tracks.every((t) => t.id && t.audioUrl && t.imageUrl));
});

test("albums, artists and playlists parse tolerantly; 30040 publication indexes are not mistaken for playlists", () => {
  const album = parseAlbum(ev(10, 30441, [["d", "al"], ["title", "First LP"], ["artist", "The Band"], ["image", "https://m.test/al.jpg"], ["a", `30440:${A}:one`], ["a", `30440:${B}:two`], ["a", `30023:${A}:essay`]]));
  assert.equal(album.title, "First LP"); assert.equal(album.id, "al"); assert.equal(album.refs.length, 2); assert.equal(album.imageUrl, "https://m.test/al.jpg");
  assert.equal(parseAlbum(ev(11, 30441, [["d", "x"]])), null, "no title");
  const artist = parseArtist(ev(12, 30442, [["d", "ar"], ["name", "The Band"], ["picture", "https://m.test/p.jpg"]]));
  assert.equal(artist.name, "The Band"); assert.equal(artist.pubkey, A);
  assert.equal(parseArtist(ev(13, 30442, [["d", "ar"], ["name", "Fan Page"], ["p", B]])).pubkey, B);
  assert.ok(parsePlaylist(ev(14, 30443, [["d", "pl"], ["title", "Mix"], ["e", H(1)]])));
  assert.ok(parsePlaylist(ev(15, 30040, [["d", "pl2"], ["title", "Mix 2"], ["a", `30440:${A}:one`]])));
  assert.equal(parsePlaylist(ev(16, 30040, [["d", "book"], ["title", "A Book"], ["a", `30041:${A}:chapter`]])), null);
  assert.equal(parsePlaylist(ev(17, 1, [])), null);
});

test("social posts: only notes that carry a direct audio link become tracks", () => {
  const post = parseSocialNote(ev(20, 1, [["t", "music"]], "Loving this one #music\nhttps://cdn.test/song.mp3?x=1 https://cdn.test/cover.png"));
  assert.equal(post.url, "https://cdn.test/song.mp3?x=1"); assert.equal(post.title, "Loving this one"); assert.equal(post.coverArt, "https://cdn.test/cover.png");
  assert.equal(post.sourceKind, 1); assert.equal(post.key, H(20));
  assert.equal(parseSocialNote(ev(21, 1, [], "check https://example.com/page")), null);
  assert.equal(parseSocialNote(ev(22, 1, [], "https://cdn.test/photo.jpg")), null);
});

test("zaps: invoice amounts and counts by e / a tag", () => {
  assert.equal(zapSats({ tags: [["bolt11", "lnbc210n1pxyz"]] }), 21);
  assert.equal(zapSats({ tags: [["bolt11", "lnbc1u1pxyz"]] }), 100);
  assert.equal(zapSats({ tags: [["bolt11", "lnbc2500u1pxyz"]] }), 250000);
  assert.equal(zapSats({ tags: [] }), 0);
  const tracks = [normalizeTrack(t30440(1, "a")), normalizeTrack(t1808(2))];
  const zap = (n, tag, inv) => ev(n, 9735, [tag, ["bolt11", inv]]);
  const counts = countZaps([zap(30, ["a", `30440:${A}:a`], "lnbc1u1p"), zap(31, ["e", H(2)], "lnbc210n1p"), zap(32, ["e", H(2)], "lnbc210n1p"), zap(30, ["a", `30440:${A}:a`], "lnbc1u1p")], tracks);
  assert.deepEqual(counts.get(tracks[0].key), { count: 1, sats: 100 }, "duplicate receipts are counted once");
  assert.deepEqual(counts.get(tracks[1].key), { count: 2, sats: 42 });
});

test("sections: fixed order, 7-day window, follows from kind 1, preview when nobody was zapped", () => {
  const tracks = [normalizeTrack(t30440(1, "new")), normalizeTrack(t1808(2, NOW - 10 * 86400)), normalizeTrack(t30440(3, "recent", [], B, NOW - 3 * 86400))];
  const pool = homePool(tracks);
  assert.equal(pool.length, 3);
  const social = [parseSocialNote(ev(20, 1, [], "https://cdn.test/a.mp3", B)), parseSocialNote(ev(21, 1, [], "https://cdn.test/b.mp3", A))];
  const albums = [parseAlbum(ev(10, 30441, [["d", "al"], ["title", "LP"]]))];
  const playlists = [parsePlaylist(ev(14, 30443, [["d", "pl"], ["title", "Mix"], ["e", H(1)]]))];
  const sections = buildSections({ pool, albums, playlists, social, followSet: new Set([B]), now: NOW, seed: 4 });
  assert.deepEqual(sections.map((s) => s.title), ["Made For You", "From Your Follows", "New on Strify", "Albums For You", "Popular Playlists", "Zapped Most Today"]);
  assert.equal(sections[0].items.length, 3);
  assert.deepEqual(sections[1].items.map((t) => t.pubkey), [B]);
  assert.deepEqual(sections[2].items.map((t) => t.title), ["Song new", "Song recent"], "last 7 days, newest first");
  assert.ok(sections[5].preview);
  const zaps = new Map([[tracks[1].key, { count: 3, sats: 300 }], [tracks[0].key, { count: 1, sats: 900 }]]);
  const live = buildSections({ pool, zaps, now: NOW }).at(-1);
  assert.ok(!live.preview); assert.deepEqual(live.items.map((t) => t.key), [tracks[0].key, tracks[1].key], "sorted by sats");
  const community = buildSections({ pool, social, followSet: new Set(), now: NOW })[1];
  assert.equal(community.title, "From The Community");
});

test("homePool keeps the strict filter for 1808 but only needs a title and audio for 30440", () => {
  const loose = normalizeTrack(ev(1, 30440, [["d", "x"], ["title", "Real Title"], ["url", "https://m.test/x.mp3"]]));
  const looseLegacy = normalizeTrack(ev(2, 1808, [], JSON.stringify({ url: "https://m.test/y.mp3", title: "Real Title" })));
  assert.equal(homePool([loose, looseLegacy]).length, 1);
});

test("extra carousels for the infinite scroll: artists, genres, per-artist catalogs", () => {
  const tracks = [];
  for (let i = 1; i <= 4; i++) tracks.push(normalizeTrack(t30440(i, `s${i}`)));
  for (let i = 5; i <= 8; i++) tracks.push(normalizeTrack(t30440(i, `s${i}`, [], B)));
  const extras = buildExtraSections({ pool: homePool(tracks), now: NOW, seed: 2 });
  const titles = extras.map((s) => s.title);
  assert.ok(titles.includes("Top in Pop") && titles.some((t) => t.startsWith("More from")));
  assert.ok(extras.every((s) => s.items.length));
  assert.equal(seededShuffle([1, 2, 3, 4, 5], 9).join(), seededShuffle([1, 2, 3, 4, 5], 9).join(), "stable for a given seed");
  assert.match(greetingFor(new Date(2026, 0, 1, 15)), /afternoon/);
});
