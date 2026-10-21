import test from "node:test";
import assert from "node:assert/strict";
import { forYouFeed, globalFeed, forYouAuthors, trackMatches, filterTracks, profileSearchNames, followsDiffer } from "../src/core/strify-feeds.js";

const H = (c) => c.repeat(64);
const ME = H("a"), FRIEND = H("b"), STRANGER = H("c");
const t = (id, pubkey, over = {}) => ({ key: id, eventId: id, kind: 1808, pubkey, createdAt: 10, title: `Song ${id}`, artist: "", genre: "", ...over });
const pools = [[t("1", ME), t("2", FRIEND, { createdAt: 20 })], [t("2", FRIEND, { createdAt: 20 }), t("3", STRANGER, { createdAt: 30 })], [t("4", FRIEND, { kind: 31337, createdAt: 40 })]];

test("For You = own + followed authors only, deduplicated, newest first", () => {
  const feed = forYouFeed({ pools, me: ME, follows: [FRIEND], kinds: [1808] });
  assert.deepEqual(feed.map((x) => x.key), ["2", "1"]);
  assert.ok(feed.every((x) => [ME, FRIEND].includes(x.pubkey)));
});
test("For You keeps the user's own music even when they follow nobody; empty when signed out", () => {
  assert.deepEqual(forYouFeed({ pools, me: ME, follows: [], kinds: [1808] }).map((x) => x.key), ["1"]);
  assert.deepEqual(forYouFeed({ pools, me: "", follows: [FRIEND], kinds: [1808] }), []);
});
test("author matching uses pubkeys, case-insensitively, never names", () => {
  const upper = [[t("9", FRIEND.toUpperCase(), { artist: FRIEND })]];
  assert.equal(forYouFeed({ pools: upper, me: ME, follows: [FRIEND], kinds: [1808] }).length, 1);
  assert.equal(forYouAuthors(ME, ["not-a-key", FRIEND]).size, 2);
});
test("Global is broader: includes strangers, own and followed, deduplicated; respects feed kinds", () => {
  const g = globalFeed({ pools, kinds: [1808] });
  assert.deepEqual(g.map((x) => x.key).sort(), ["1", "2", "3"]);
  assert.ok(globalFeed({ pools, kinds: [1808] }).length > forYouFeed({ pools, me: ME, follows: [FRIEND], kinds: [1808] }).length - 1);
  assert.equal(globalFeed({ pools, kinds: [1808, 31337] }).length, 4);
});
test("search: title, artist tag, profile names and genre; case-insensitive, partial, multi-word", () => {
  const track = t("5", FRIEND, { title: "Nakamotos Dream", artist: "InvalidCastX", genre: "Pop" });
  const names = (pk) => (pk === FRIEND ? ["Ada Lovelace", "ada@example.com"] : []);
  for (const q of ["nakamoto", "DREAM", "invalidcast", "pop", "lovelace", "ada@ex", "dream pop", "  pop   dream "]) assert.ok(trackMatches(track, q, names), q);
  for (const q of ["jazz", "dream jazz", "zzz"]) assert.ok(!trackMatches(track, q, names), q);
  assert.ok(trackMatches(track, "", names));
});
test("search never invents genre and respects the catalog it is given (cannot bypass feed rules)", () => {
  const noGenre = t("6", ME, { title: "Plain" });
  assert.ok(!trackMatches(noGenre, "pop"));
  const forYou = forYouFeed({ pools, me: ME, follows: [FRIEND], kinds: [1808] });
  assert.equal(filterTracks(forYou, "Song 3").length, 0); // stranger's track stays out of For You search
  assert.equal(filterTracks(globalFeed({ pools, kinds: [1808] }), "Song 3").length, 1);
});
test("profileSearchNames only returns fields the profile has; followsDiffer detects changes", () => {
  assert.deepEqual(profileSearchNames({ display_name: "A", name: "", nip05: "a@b.c", about: "x" }), ["A", "a@b.c"]);
  assert.deepEqual(profileSearchNames(undefined), []);
  assert.equal(followsDiffer([FRIEND], [FRIEND]), false);
  assert.equal(followsDiffer([FRIEND], [FRIEND, STRANGER]), true);
});
