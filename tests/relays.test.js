import test from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const R = await import("../src/core/relays.js");

test("defaults: bchnostr first, then the 20 listed relays, all read+write", () => {
  const list = R.getRelays();
  assert.equal(list[0].url, "wss://relay.bchnostr.com");
  assert.equal(list.length, 21);
  assert.ok(list.every((r) => r.read && r.write));
  assert.equal(R.readRelays()[0], "wss://relay.bchnostr.com");
});

test("normalizeRelayUrl accepts bare hosts, rejects insecure and junk", () => {
  assert.equal(R.normalizeRelayUrl("relay.example.com/").url, "wss://relay.example.com");
  assert.equal(R.normalizeRelayUrl("WSS://Relay.Example.com").url, "wss://relay.example.com");
  assert.ok(R.normalizeRelayUrl("ws://relay.example.com").error);
  assert.ok(R.normalizeRelayUrl("https://example.com").error);
  assert.ok(R.normalizeRelayUrl("localhost").error);
  assert.ok(R.normalizeRelayUrl("").error);
});

test("add, toggle, remove and persistence; the last read relay is protected", () => {
  assert.ok(R.addRelay("wss://relay.damus.io").error, "duplicates are refused");
  assert.equal(R.addRelay("relay.example.com", { write: false }).relays.at(-1).write, false);
  assert.ok(!R.writeRelays().includes("wss://relay.example.com"));
  assert.ok(JSON.parse(mem.get("strify:relays:v1")).some((r) => r.url === "wss://relay.example.com"));
  R.setRelays([{ url: "wss://a.example.com", read: true, write: true }]);
  assert.ok(R.removeRelay("wss://a.example.com").error);
  assert.ok(R.updateRelay("wss://a.example.com", { read: false }).error);
  R.resetRelays();
  assert.equal(R.getRelays().length, 21);
});

test("mergeRelayListEvent adds new relays with their read/write markers and keeps existing ones", () => {
  R.resetRelays();
  const added = R.mergeRelayListEvent({ tags: [["r", "wss://new.example.com", "read"], ["r", "wss://relay.damus.io"], ["r", "ws://insecure.example.com"], ["p", "x"]] });
  assert.equal(added, 1);
  const added1 = R.getRelays().find((r) => r.url === "wss://new.example.com");
  assert.deepEqual([added1.read, added1.write], [true, false]);
  R.resetRelays();
});
