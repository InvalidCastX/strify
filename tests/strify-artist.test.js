import test from "node:test";
import assert from "node:assert/strict";
import { parseArtistParam, artistPath, artistFilter, artistTracksOnly, mergeArtistPage, oldestCreatedAt, hasMorePages, ARTIST_PAGE_SIZE } from "../src/core/strify-artist.js";
import { resolveAudioEvents } from "../src/core/strify-tracks.js";
import { npubFromHex } from "../src/core/nostr-core.js";

const H = (c) => c.repeat(64);
const ARTIST = H("a");
const OTHER = H("b");
const ev = (id, pubkey, created_at, over = {}) => ({
  id: H(id), pubkey, kind: 1808, created_at, tags: [],
  content: JSON.stringify({ url: `https://cdn.example/${id}.mp3`, title: `Song ${id}`, artist: "Same Name", duration: 100, coverArt: "https://cdn.example/c.jpg" }), ...over,
});

test("artist param accepts npub and hex, rejects junk", () => {
  assert.equal(parseArtistParam(`?artist=${npubFromHex(ARTIST)}`), ARTIST);
  assert.equal(parseArtistParam(`?artist=${ARTIST.toUpperCase()}`), ARTIST);
  assert.equal(parseArtistParam("?artist=not-a-key"), null);
  assert.equal(parseArtistParam("?other=1"), null);
  assert.equal(parseArtistParam(""), null);
});

test("artist path round-trips through the param parser", () => {
  assert.equal(parseArtistParam(artistPath(ARTIST).split("?")[1] ? `?${artistPath(ARTIST).split("?")[1]}` : ""), ARTIST);
});

test("filter targets exactly kind 1808 by this pubkey and pages with until", () => {
  assert.deepEqual(artistFilter(ARTIST), { kinds: [1808], authors: [ARTIST], limit: ARTIST_PAGE_SIZE });
  assert.equal(artistFilter(ARTIST, { until: 500 }).until, 500);
});

test("only this pubkey's kind 1808 tracks are kept, even if a relay ignores the authors filter", async () => {
  const { tracks } = await resolveAudioEvents([
    ev("1", ARTIST, 300), ev("2", OTHER, 400), ev("3", ARTIST, 200),
    { ...ev("4", ARTIST, 100), kind: 31337, tags: [["d", "x"], ["title", "Other kind"], ["media", "https://cdn.example/4.mp3"]] },
  ]);
  const mine = artistTracksOnly(tracks, ARTIST);
  assert.deepEqual(mine.map((t) => t.eventId[0]), ["1", "3"]);
  assert.ok(mine.every((t) => t.pubkey === ARTIST));
});

test("same display name, different pubkey: identity comes from the pubkey", async () => {
  const { tracks } = await resolveAudioEvents([ev("1", ARTIST, 300), ev("2", OTHER, 400)]);
  assert.equal(tracks.filter((t) => t.artist === "Same Name").length, 2);
  assert.equal(artistTracksOnly(tracks, ARTIST).length, 1);
  assert.equal(artistTracksOnly(tracks, OTHER).length, 1);
});

test("merging pages dedupes by event id and keeps newest first", async () => {
  const a = (await resolveAudioEvents([ev("1", ARTIST, 300), ev("2", ARTIST, 200)])).tracks;
  const b = (await resolveAudioEvents([ev("2", ARTIST, 200), ev("3", ARTIST, 100)])).tracks;
  const merged = mergeArtistPage(a, b, ARTIST);
  assert.deepEqual(merged.tracks.map((t) => t.createdAt), [300, 200, 100]);
  assert.equal(merged.added, 1);
});

test("incomplete metadata still yields a track with fallbacks; unplayable events are dropped", async () => {
  const sparse = ev("5", ARTIST, 50, { content: JSON.stringify({ url: "https://cdn.example/5.mp3" }) });
  const dead = ev("6", ARTIST, 60, { content: JSON.stringify({ title: "No audio" }) });
  const { tracks, skipped } = await resolveAudioEvents([sparse, dead]);
  const mine = artistTracksOnly(tracks, ARTIST);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, "Untitled track");
  assert.equal(skipped, 1);
});

test("cursor and pagination decisions", () => {
  assert.equal(oldestCreatedAt([ev("1", ARTIST, 300), ev("2", ARTIST, 100), ev("3", OTHER, 5)], ARTIST), 100);
  assert.equal(oldestCreatedAt([], ARTIST), null);
  assert.equal(hasMorePages({ scanned: ARTIST_PAGE_SIZE, added: 5, cursorMoved: true }), true);
  assert.equal(hasMorePages({ scanned: 10, added: 10, cursorMoved: true }), false);   // short page: relays exhausted
  assert.equal(hasMorePages({ scanned: ARTIST_PAGE_SIZE, added: 0, cursorMoved: true }), false); // no progress
  assert.equal(hasMorePages({ scanned: ARTIST_PAGE_SIZE, added: 5, cursorMoved: false }), false);
});

test("own tracks are pulled to the top and never repeated in the rest", async () => {
  const { withoutOwn } = await import("../src/core/strify-artist.js");
  const all = (await resolveAudioEvents([ev("1", ARTIST, 300), ev("2", OTHER, 200), ev("3", OTHER, 100)])).tracks;
  const mine = artistTracksOnly(all, ARTIST);
  const rest = withoutOwn(all, mine);
  assert.deepEqual(mine.map((t) => t.eventId[0]), ["1"]);
  assert.deepEqual(rest.map((t) => t.eventId[0]), ["2", "3"]);
  assert.equal(withoutOwn(all, []).length, 3);
});
