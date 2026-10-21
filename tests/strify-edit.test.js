import test from "node:test";
import assert from "node:assert/strict";
import { buildEditedTemplate, buildTrackTemplate, licenseOfEvent } from "../src/core/strify-upload.js";

const track = { url: "https://x.test/a.mp3", coverArt: "https://x.test/c.jpg", duration: 200, title: "Old", artist: "Me", genre: "Pop" };
const original = {
  content: JSON.stringify({ url: track.url, title: "Old", artist: "Me", duration: 200, paidSats: 0, coverArt: track.coverArt, genre: "Pop", description: "keep me" }),
  tags: [["t", "strify-track"], ["t", "music"], ["t", "strify-genre-pop"], ["license", "CC BY 4.0"], ["t", "custom-tag"], ["client", "x"]],
};

test("an edit keeps the audio, duration and unmanaged fields and tags", () => {
  const t = buildEditedTemplate({ track, original, title: "New", artist: "Me", genre: "Rock", license: "CC0 (public domain)" });
  const data = JSON.parse(t.content);
  assert.equal(t.kind, 1808);
  assert.equal(data.title, "New"); assert.equal(data.genre, "Rock"); assert.equal(data.url, track.url); assert.equal(data.duration, 200); assert.equal(data.description, "keep me");
  assert.deepEqual(t.tags.filter((x) => x[0] === "license"), [["license", "CC0 (public domain)"]]);
  assert.ok(t.tags.some((x) => x[1] === "strify-genre-rock")); assert.ok(!t.tags.some((x) => x[1] === "strify-genre-pop"));
  assert.ok(t.tags.some((x) => x[1] === "custom-tag")); assert.ok(t.tags.some((x) => x[0] === "client"));
});

test("a new cover replaces the old one; no original still works", () => {
  assert.equal(JSON.parse(buildEditedTemplate({ track, original, title: "T", artist: "A", genre: "Pop", coverArt: "https://y.test/n.png" }).content).coverArt, "https://y.test/n.png");
  assert.deepEqual(buildEditedTemplate({ track, title: "T", artist: "A", genre: "Pop" }).tags, buildTrackTemplate({ ...track, title: "T", artist: "A", genre: "Pop" }).tags);
  assert.throws(() => buildEditedTemplate({ track: { ...track, coverArt: "" }, title: "T", artist: "A", genre: "Pop" }), /https/);
});

test("licenseOfEvent reads the license tag", () => {
  assert.equal(licenseOfEvent(original), "CC BY 4.0"); assert.equal(licenseOfEvent({ tags: [] }), "");
});
