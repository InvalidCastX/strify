import test from "node:test";
import assert from "node:assert/strict";
import { buildStatusTemplate, buildClearStatusTemplate, parseStatusEvent, liveStatuses, STATUS_KIND } from "../src/core/strify-status.js";

const H = (c) => c.repeat(64);
const NOW = 1_800_000_000;
const track = { eventId: H("1"), kind: 1808, pubkey: H("a"), title: "Nakamotos Dream", artist: "InvalidCastX", duration: 277, coverArt: "https://x.test/c.jpg", url: "https://x.test/a.mp3" };
const signed = (tpl, pubkey = H("b")) => ({ ...tpl, id: H("9"), pubkey, sig: "s" });

test("NIP-38 music status: kind 30315, d=music, expires after the track, references the track event", () => {
  const t = buildStatusTemplate(track, { now: NOW, remaining: 200 });
  assert.equal(t.kind, STATUS_KIND);
  assert.deepEqual(t.tags[0], ["d", "music"]);
  assert.deepEqual(t.tags.find((x) => x[0] === "expiration"), ["expiration", String(NOW + 230)]);
  assert.deepEqual(t.tags.find((x) => x[0] === "e"), ["e", H("1")]);
  assert.equal(t.content, "Nakamotos Dream — InvalidCastX");
});
test("parse: live status resolves track reference, cover and text; hostile URLs are dropped", () => {
  const p = parseStatusEvent(signed(buildStatusTemplate(track, { now: NOW })), NOW + 5);
  assert.equal(p.title, "Nakamotos Dream"); assert.equal(p.artist, "InvalidCastX");
  assert.deepEqual(p.trackRef, { id: H("1") }); assert.equal(p.cover, "https://x.test/c.jpg");
  const bad = parseStatusEvent(signed({ ...buildStatusTemplate({ ...track, coverArt: "javascript:alert(1)", url: "http://x/a.mp3" }, { now: NOW }) }), NOW + 5);
  assert.equal(bad.cover, ""); assert.equal(bad.url, "");
});
test("expired, cleared, non-music and malformed statuses are not live", () => {
  assert.equal(parseStatusEvent(signed(buildStatusTemplate(track, { now: NOW, remaining: 10 })), NOW + 100_000), null);
  assert.equal(parseStatusEvent(signed(buildClearStatusTemplate(NOW)), NOW + 1), null);
  assert.equal(parseStatusEvent(signed({ kind: 30315, tags: [["d", "general"]], content: "hi" }), NOW), null);
  assert.equal(parseStatusEvent({ kind: 1, pubkey: H("b"), tags: [], content: "x" }, NOW), null);
});
test("a status without an expiration tag is only trusted for 10 minutes", () => {
  const ev = signed({ kind: 30315, created_at: NOW, tags: [["d", "music"]], content: "Song" });
  assert.ok(parseStatusEvent(ev, NOW + 300)); assert.equal(parseStatusEvent(ev, NOW + 700), null);
});
test("liveStatuses: newest per author wins, so a newer clear hides an older live status", () => {
  const live = signed({ ...buildStatusTemplate(track, { now: NOW }), created_at: NOW }, H("b"));
  const cleared = signed({ ...buildClearStatusTemplate(NOW + 10), created_at: NOW + 10 }, H("b"));
  const other = signed({ ...buildStatusTemplate(track, { now: NOW }), created_at: NOW }, H("c"));
  const map = liveStatuses([live, cleared, other], NOW + 20);
  assert.equal(map.has(H("b")), false); assert.equal(map.has(H("c")), true);
});
