import test from "node:test";
import assert from "node:assert/strict";
import { assessTrack, isRealMusic, filterRealMusic } from "../src/core/strify-quality.js";
import { createHistory } from "../src/core/strify-history.js";
import { recommend, topGenres } from "../src/core/strify-reco.js";
import {
  validateAudioFile, validateCoverFile, validateDetails, buildTrackTemplate, genreSlug, blossomUpload, uploadFile, serversFromEvent, base64Utf8,
} from "../src/core/strify-upload.js";
import { checkCopyright, nostrDuplicates, musicBrainzMatches, normalizeText } from "../src/core/strify-copyright.js";
import { parseAudioEvent } from "../src/core/strify-tracks.js";

const hex = (n) => n.toString(16).padStart(64, "0");
const A = hex(1), B = hex(2), ME = hex(9);
const song = (over = {}) => ({ key: `k${Math.random()}`, eventId: hex(100), pubkey: A, kind: 1808, createdAt: 1000, url: "https://x.test/a.mp3", title: "Nakamotos Dream", artist: "InvalidCastX", genre: "Pop", duration: 277, coverArt: "https://x.test/c.jpg", ...over });

// ── quality filter ──────────────────────────────────────────────────
test("a complete song passes; a recorded sound does not", () => {
  assert.equal(isRealMusic(song()), true);
  assert.deepEqual(assessTrack(song({ title: "Untitled track", artist: "", coverArt: "", genre: "", duration: 0 })).missing, ["title", "artist", "cover", "genre", "duration"]);
  assert.equal(isRealMusic(song({ title: "voice memo 3" })), false);
  assert.equal(isRealMusic(song({ title: "recording_2024.wav" })), false);
  assert.equal(isRealMusic(song({ title: "a3f9c2d1e8b74f60" })), false);
  assert.equal(isRealMusic(song({ artist: "Unknown Artist" })), false);
  assert.equal(isRealMusic(song({ duration: 12 })), false, "a 12 second clip is a sound, not a song");
  assert.equal(isRealMusic(song({ duration: 9 * 3600 })), false);
  assert.equal(isRealMusic(song({ coverArt: "http://insecure.test/c.jpg" })), false);
  assert.equal(filterRealMusic([song(), song({ title: "test" })]).length, 1);
});

test("the example kind 1808 event from the brief is a real, playable song", () => {
  const event = {
    id: hex(7), pubkey: hex(8), kind: 1808, created_at: 1784336879, sig: "s".repeat(128),
    content: JSON.stringify({ url: "https://npub1y4s67mks7j3y2ezk2nk63sk2v9ujetj6vcstj27ht3p0htkvarrs5h5v4f.blossom.band/6b36f5f65647253ed646d230e9ca49b4d9e3ca605d9a013f6c6b1003a55a51f5.mp3", title: "#2 Nakamotos Dream", artist: "InvalidCastX", duration: 277, paidSats: 0, coverArt: "https://npub1y4s67mks7j3y2ezk2nk63sk2v9ujetj6vcstj27ht3p0htkvarrs5h5v4f.blossom.band/726cad4e80716f198c98a8c37fd8594ae0ebaf41019400f76380700b93cf5494.jpg", genre: "Pop" }),
    tags: [["t", "bch-radio-track"], ["t", "bch"], ["t", "bch-radio"], ["t", "bch-radio-genre-pop"]],
  };
  const parsed = parseAudioEvent(event);
  assert.equal(parsed.status, "ready");
  assert.equal(isRealMusic(parsed.track), true);
});

// ── history ─────────────────────────────────────────────────────────
function memoryStorage() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; }

test("history keeps newest first, de-duplicates, caps, and is per account", () => {
  const h = createHistory(memoryStorage(), { max: 3 });
  const [t1, t2, t3, t4] = [1, 2, 3, 4].map((n) => song({ key: `t${n}`, title: `Song ${n}` }));
  [t1, t2, t3].forEach((t) => h.record(t, ME));
  h.record(t1, ME);
  assert.deepEqual(h.list(ME).map((t) => t.key), ["t1", "t3", "t2"]);
  h.record(t4, ME);
  assert.deepEqual(h.list(ME).map((t) => t.key), ["t4", "t1", "t3"]);
  assert.equal(h.list(A).length, 0);
  h.clear(ME);
  assert.equal(h.list(ME).length, 0);
});

test("history drops unplayable or tampered entries on read", () => {
  const storage = memoryStorage();
  storage.setItem("strify:recent:anon", JSON.stringify([{ key: "x", pubkey: "nope", url: "https://a.test/a.mp3" }, { key: "y", pubkey: A, url: "javascript:alert(1)" }, { key: "z", pubkey: A, url: "https://a.test/a.mp3", title: "ok" }]));
  assert.deepEqual(createHistory(storage).list("").map((t) => t.key), ["z"]);
});

// ── recommendations ─────────────────────────────────────────────────
test("recommend: taste-based sections, never your own or already-heard songs, one section per track", () => {
  const catalog = [
    song({ key: "p1", genre: "Pop", pubkey: A, createdAt: 5 }), song({ key: "p2", genre: "Pop", pubkey: B, createdAt: 4 }),
    song({ key: "r1", genre: "Rock", pubkey: B, createdAt: 3 }), song({ key: "mine", genre: "Pop", pubkey: ME, createdAt: 9 }),
    song({ key: "junk", title: "test", pubkey: B, createdAt: 8 }),
  ];
  const sections = recommend({ catalog, recent: [catalog[0]], liked: [], follows: new Set([B]), me: ME });
  const ids = sections.map((s) => s.id);
  assert.ok(ids.includes("because-genre") && ids.includes("follows"));
  const all = sections.flatMap((s) => s.tracks.map((t) => t.key));
  assert.equal(new Set(all).size, all.length);
  assert.ok(!all.includes("mine") && !all.includes("p1") && !all.includes("junk"));
  assert.deepEqual(recommend({ catalog: [], recent: [], liked: [] }), []);
});

test("topGenres ranks by count and keeps the display casing", () => {
  assert.deepEqual(topGenres([song({ genre: "Pop" }), song({ genre: "pop" }), song({ genre: "Jazz" })]).map((g) => [g.genre, g.count]), [["Pop", 2], ["Jazz", 1]]);
});

// ── upload ──────────────────────────────────────────────────────────
test("file validation", () => {
  assert.equal(validateAudioFile({ name: "a.mp3", type: "audio/mpeg", size: 5e6 }), "");
  assert.equal(validateAudioFile({ name: "a.flac", type: "", size: 5e6 }), "");
  assert.match(validateAudioFile({ name: "a.exe", type: "application/x-msdownload", size: 5 }), /MP3/);
  assert.match(validateAudioFile({ name: "a.mp3", type: "audio/mpeg", size: 99e6 }), /limited/);
  assert.equal(validateCoverFile({ name: "c.jpg", type: "image/jpeg", size: 1e5 }), "");
  assert.match(validateCoverFile({ name: "c.gif", type: "image/gif", size: 1e5 }), /JPG/);
  assert.match(validateCoverFile(null), /Choose/);
});

test("details validation trims and requires title, artist and genre", () => {
  const bad = validateDetails({ title: " ", artist: "", genre: "" });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["artist", "genre", "title"]);
  const ok = validateDetails({ title: "  Nakamotos   Dream ", artist: "InvalidCastX", genre: "Pop" });
  assert.equal(ok.ok, true);
  assert.equal(ok.values.title, "Nakamotos Dream");
});

test("buildTrackTemplate matches the kind 1808 shape other players read", () => {
  const t = buildTrackTemplate({ url: "https://b.test/a.mp3", coverArt: "https://b.test/c.jpg", title: "Nakamotos Dream", artist: "InvalidCastX", genre: "Hip-Hop", duration: 277.4, license: "CC BY 4.0" });
  assert.equal(t.kind, 1808);
  assert.deepEqual(JSON.parse(t.content), { url: "https://b.test/a.mp3", title: "Nakamotos Dream", artist: "InvalidCastX", duration: 277, paidSats: 0, coverArt: "https://b.test/c.jpg", genre: "Hip-Hop" });
  assert.deepEqual(t.tags, [["t", "strify-track"], ["t", "music"], ["t", "strify-genre-hip-hop"], ["license", "CC BY 4.0"]]);
  assert.equal(genreSlug("R&B"), "randb");
  assert.throws(() => buildTrackTemplate({ url: "http://x.test/a.mp3", coverArt: "https://b.test/c.jpg", title: "t", artist: "a", genre: "Pop" }), /https/);
  // what we publish must be accepted as a real song by strify itself
  const event = { id: hex(5), pubkey: A, kind: 1808, created_at: 1, sig: "s".repeat(128), ...t };
  assert.equal(isRealMusic(parseAudioEvent(event).track), true);
});

const fakeFile = (bytes = [1, 2, 3], over = {}) => ({ name: "song.mp3", type: "audio/mpeg", size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer, ...over });
const okResponse = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const failResponse = (status, reason) => ({ ok: false, status, headers: { get: (h) => (h === "x-reason" ? reason : null) }, json: async () => ({}), text: async () => "" });

test("blossomUpload signs a kind 24242 auth for the file hash and PUTs to /upload", async () => {
  let call; let authEvent;
  const file = fakeFile();
  const result = await blossomUpload({
    server: "https://blossom.test/", file, now: 1000,
    sign: async (template) => { authEvent = template; return { ...template, id: "i", sig: "s", pubkey: A }; },
    fetchImpl: async (url, init) => { call = { url, init }; return okResponse({ url: "https://blossom.test/abc.mp3", sha256: undefined }); },
  });
  assert.equal(call.url, "https://blossom.test/upload");
  assert.equal(call.init.method, "PUT");
  assert.equal(authEvent.kind, 24242);
  assert.deepEqual(authEvent.tags.find((t) => t[0] === "t"), ["t", "upload"]);
  assert.equal(authEvent.tags.find((t) => t[0] === "x")[1], call.init.headers["X-SHA-256"]);
  assert.equal(authEvent.tags.find((t) => t[0] === "expiration")[1], "1600");
  assert.match(call.init.headers.Authorization, /^Nostr /);
  assert.equal(JSON.parse(atob(call.init.headers.Authorization.slice(6))).kind, 24242);
  assert.equal(result.url, "https://blossom.test/abc.mp3");
});

test("blossomUpload rejects hash mismatches, insecure URLs and server errors with a readable reason", async () => {
  const base = { server: "https://b.test", file: fakeFile(), sign: async (t) => t };
  await assert.rejects(blossomUpload({ ...base, fetchImpl: async () => okResponse({ url: "https://b.test/x", sha256: "0".repeat(64) }) }), /hash mismatch/);
  await assert.rejects(blossomUpload({ ...base, fetchImpl: async () => okResponse({ url: "http://b.test/x" }) }), /https/);
  await assert.rejects(blossomUpload({ ...base, fetchImpl: async () => failResponse(413, "File too large") }), /File too large/);
});

test("uploadFile falls through servers, then the nostr.build fallback", async () => {
  const tried = [];
  const fetchImpl = async (url) => { if (url.startsWith("https://one.test")) return failResponse(500, "down"); return okResponse({ url: "https://two.test/f.mp3" }); };
  const r = await uploadFile({ file: fakeFile(), servers: ["https://one.test", "https://two.test"], sign: async (t) => t, fetchImpl, onTry: (n) => tried.push(n) });
  assert.equal(r.url, "https://two.test/f.mp3");
  assert.deepEqual(tried, ["one.test", "two.test"]);
  const r2 = await uploadFile({ file: fakeFile(), servers: ["https://one.test"], sign: async (t) => t, fetchImpl: async () => failResponse(500, "down"), fallback: async () => "https://nostr.build/i/x.mp3" });
  assert.equal(r2.url, "https://nostr.build/i/x.mp3");
  await assert.rejects(uploadFile({ file: fakeFile(), servers: ["https://one.test"], sign: async (t) => t, fetchImpl: async () => failResponse(500, "down") }), /Couldn't upload/);
  // nostr.build is skipped for files above its free limit
  let used = false;
  await assert.rejects(uploadFile({ file: fakeFile([1], { size: 25 * 1024 * 1024 }), servers: [], sign: async (t) => t, fetchImpl: async () => failResponse(500, ""), fallback: async () => { used = true; return "https://x.test/a"; } }));
  assert.equal(used, false);
});

test("serversFromEvent reads https server tags from kind 10063; base64Utf8 handles unicode", () => {
  assert.deepEqual(serversFromEvent({ kind: 10063, tags: [["server", "https://a.test/"], ["server", "http://bad.test"], ["x", "y"]] }), ["https://a.test"]);
  assert.equal(atob(base64Utf8("é")).length, 2);
});

// ── copyright check ─────────────────────────────────────────────────
test("normalizeText ignores case, accents, punctuation and feat./remix suffixes", () => {
  assert.equal(normalizeText("Bohemian Rhapsody (Remastered 2011)"), "bohemian rhapsody");
  assert.equal(normalizeText("Café — Del Mar feat. Someone"), "cafe del mar");
  assert.equal(normalizeText("Song - Radio Edit"), "song");
});

test("nostrDuplicates flags the same title+artist from a different account only", () => {
  const known = [song({ title: "Nakamotos Dream", artist: "InvalidCastX", pubkey: B }), song({ title: "Nakamotos Dream", artist: "InvalidCastX", pubkey: ME }), song({ title: "Other", pubkey: B })];
  const d = nostrDuplicates(known, { title: "nakamotos dream", artist: "invalidcastx", me: ME });
  assert.equal(d.length, 1);
  assert.equal(d[0].pubkey, B);
});

const mbRecording = (over = {}) => ({ id: "r1", score: 100, title: "Bohemian Rhapsody", "artist-credit": [{ name: "Queen" }], releases: [{ title: "A Night at the Opera", date: "1975-11-21" }], ...over });

test("musicBrainzMatches needs an exact title, a high score and at least one release", () => {
  const m = musicBrainzMatches([mbRecording(), mbRecording({ id: "r2", score: 60 }), mbRecording({ id: "r3", releases: [] }), mbRecording({ id: "r4", title: "Other" })], { title: "Bohemian Rhapsody", artist: "Me" });
  assert.equal(m.length, 1);
  assert.equal(m[0].sameArtist, false);
  assert.match(m[0].detail, /different artist/);
  assert.match(m[0].detail, /1975/);
});

test("checkCopyright: review on a match, clear when nothing matches, unavailable when every lookup fails", async () => {
  const sleep = async () => {};
  const withData = async () => ({ ok: true, json: async () => ({ recordings: [mbRecording()] }) });
  const review = await checkCopyright({ title: "Bohemian Rhapsody", artist: "Me", me: ME, fetchImpl: withData, sleep });
  assert.equal(review.verdict, "review");
  assert.equal(review.matches[0].artist, "Queen");
  const empty = async () => ({ ok: true, json: async () => ({ recordings: [] }) });
  assert.equal((await checkCopyright({ title: "Nakamotos Dream", artist: "InvalidCastX", me: ME, fetchImpl: empty, sleep })).verdict, "clear");
  const down = async () => { throw new Error("offline"); };
  const unavailable = await checkCopyright({ title: "x y", artist: "z", me: ME, fetchImpl: down, sleep });
  assert.equal(unavailable.verdict, "unavailable");
  assert.equal(unavailable.checked, false);
  // a Nostr duplicate alone is enough for review even if MusicBrainz is down
  const dup = await checkCopyright({ title: "Nakamotos Dream", artist: "InvalidCastX", me: ME, knownTracks: [song({ pubkey: B })], fetchImpl: down, sleep });
  assert.equal(dup.verdict, "review");
});

test("checkCopyright sends one title query, plus an artist query when an artist is given, with Lucene characters stripped", async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(decodeURIComponent(url)); return { ok: true, json: async () => ({ recordings: [] }) }; };
  await checkCopyright({ title: 'He said "go" (live)', artist: "A:B", me: ME, fetchImpl, sleep: async () => {} });
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => !u.includes('""') && !u.includes("A:B")));
});
