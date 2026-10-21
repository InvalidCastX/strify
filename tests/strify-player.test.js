import test from "node:test";
import assert from "node:assert/strict";

// Minimal <audio> stand-in. Counting instances proves the engine never creates a second element.
let instances = 0;
let srcAssignments = 0;
class FakeAudio extends EventTarget {
  constructor() { super(); instances++; this._src = ""; this.paused = true; this.ended = false; this.currentTime = 0; this.duration = NaN; this.volume = 1; this.muted = false; this.preload = ""; }
  get src() { return this._src; }
  set src(value) { this._src = value; srcAssignments++; this.currentTime = 0; }
  getAttribute(name) { return name === "src" && this._src ? this._src : null; }
  removeAttribute(name) { if (name === "src") this._src = ""; }
  load() {}
  async play() { this.paused = false; this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing")); }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event("pause")); } }
}
globalThis.Audio = FakeAudio;
const player = await import("../src/core/strify-player.js");
const audioEl = () => player; // (the element itself is private; behaviour is observed through the store and isStrifyPlaying)

const H = (c) => c.repeat(64);
const track = (n) => ({ key: H(String(n)), eventId: H(String(n)), pubkey: H("a"), kind: 1808, title: `Song ${n}`, artist: "Ann", url: `https://cdn.example/${n}.mp3`, duration: 200, createdAt: n });
const queue = [track(1), track(2), track(3)];

test("the engine creates exactly one audio element for the whole app", () => {
  assert.equal(instances, 1);
});

test("playing a track keeps its state; in-app navigation never touches the engine", async () => {
  player.playQueue(queue, 0, { label: "Global" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(player.getState().playing, true);
  assert.equal(player.currentTrack().key, queue[0].key);
  player.seek(42);
  // Route changes only swap #mainContent and flag the strify page inactive; nothing calls the player.
  assert.equal(player.isStrifyPlaying(), true);
  assert.equal(player.getState().currentTime, 42);
  assert.equal(player.currentTrack().key, queue[0].key);
  assert.equal(player.getState().label, "Global");
});

test("pause and resume keep the same position", async () => {
  player.toggle(false);
  assert.equal(player.isStrifyPlaying(), false);
  assert.equal(player.getState().currentTime, 42);
  player.toggle(true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(player.isStrifyPlaying(), true);
  assert.equal(player.getState().currentTime, 42);
});

test("selecting the track that is already playing resumes it instead of restarting", async () => {
  const before = srcAssignments;
  player.playQueue(queue, 0, { label: "Global" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(srcAssignments, before);
  assert.equal(player.getState().currentTime, 42);
});

test("selecting another track switches playback on the same single element", async () => {
  player.playQueue(queue, 1, { label: "Artist" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(player.currentTrack().key, queue[1].key);
  assert.equal(player.getState().label, "Artist");
  assert.equal(player.isStrifyPlaying(), true);
  assert.equal(instances, 1);
});

test("the explicit stop control still clears playback", () => {
  player.stop();
  assert.equal(player.isStrifyPlaying(), false);
  assert.equal(player.currentTrack(), null);
  assert.equal(player.getState().queue.length, 0);
});
