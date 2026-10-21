import test from "node:test";
import assert from "node:assert/strict";
import { resolveFollows } from "../src/core/strify-follows.js";

const H = (c) => c.repeat(64);
const ME = H("a");
const kind3 = (created_at, keys, pubkey = ME) => ({ kind: 3, pubkey, created_at, tags: keys.map((k) => ["p", k]) });

test("the follow list the app already has is used without asking any relay", async () => {
  let asked = 0;
  const r = await resolveFollows({ me: ME, known: [H("b"), H("C"), "junk", H("b")], fetchEvents: async () => { asked++; return []; } });
  assert.equal(asked, 0);
  assert.deepEqual(r, { follows: [H("b"), H("c")], state: "found" });
});

test("when the app has no list, relays are asked and the newest kind 3 wins", async () => {
  const r = await resolveFollows({ me: ME, known: [], fetchEvents: async () => [kind3(1, [H("b")]), kind3(5, [H("c"), H("d")])] });
  assert.deepEqual(r, { follows: [H("c"), H("d")], state: "found" });
});

test("a follow list that follows nobody is reported as empty, not missing", async () => {
  const r = await resolveFollows({ me: ME, known: null, fetchEvents: async () => [kind3(1, [])] });
  assert.deepEqual(r, { follows: [], state: "empty" });
});

test("no follow list on any relay that answered is reported as none", async () => {
  const r = await resolveFollows({ me: ME, known: undefined, fetchEvents: async () => [] });
  assert.deepEqual(r, { follows: [], state: "none" });
});

test("another account's contact list is ignored", async () => {
  const r = await resolveFollows({ me: ME, known: [], fetchEvents: async () => [kind3(9, [H("b")], H("f"))] });
  assert.equal(r.state, "none");
});

test("a relay failure surfaces as an error instead of pretending there is no list", async () => {
  await assert.rejects(resolveFollows({ me: ME, known: [], fetchEvents: async () => { throw new Error("Couldn't reach any relay."); } }), /reach any relay/);
});
