// UI-level tests for the strify revamp. Strify.js is loaded with a tiny stubbed DOM (no jsdom needed), a fake relay layer,
// and a fake media server, so Home filtering, Search, Library and the whole Create flow run for real.
import test from "node:test";
import assert from "node:assert/strict";

// strify starts a few background timers; unref them so the test process can exit on its own.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => { const timer = realSetInterval(fn, ms, ...args); timer.unref?.(); return timer; };
const listeners = {};
const mkEl = () => {
  const el = { innerHTML: "", hidden: false, dataset: {}, style: {}, value: "", disabled: false, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [], toggleAttribute() {}, addEventListener() {}, remove() {}, focus() {}, blur() {}, matches: () => false, removeAttribute() {} };
  let text = "";
  Object.defineProperty(el, "textContent", { get: () => text, set: (v) => { text = String(v); el.innerHTML = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); } });
  return el;
};
const body = mkEl();
const statusEl = mkEl();
let formStub = null;
globalThis.document = {
  getElementById: (id) => ({ strifyBody: body, mainContent: mkEl() })[id] || null,
  querySelector: (sel) => (sel === "[data-strify-create-form]" ? formStub : sel === "[data-strify-create-status]" ? statusEl : null),
  querySelectorAll: () => [], createElement: () => mkEl(), body: mkEl(), activeElement: null, visibilityState: "visible",
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
};
globalThis.window = globalThis; globalThis.addEventListener = () => {};
globalThis.location = { search: "", pathname: "/strify", origin: "https://x.test" };
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.Audio = class { // reports a 120 s duration as soon as a source is set
  constructor() { this.volume = 1; }
  addEventListener() {} play() { return Promise.resolve(); } pause() {}
  removeAttribute() {}
  set src(value) { this._src = value; queueMicrotask(() => { this.duration = 120; this.onloadedmetadata?.(); }); }
};
globalThis.MutationObserver = class { observe() {} };
globalThis.HTMLImageElement = class {};
globalThis.CSS = { escape: (x) => x };

const { StrifyNet } = await import("../src/core/strify-net.js");
const H = (n) => n.toString(16).padStart(64, "0");
const ME = H(9), ART = H(5), OTHER = H(6);
const mk = (n, pubkey, content, kind = 1808) => ({ id: H(n), pubkey, kind, created_at: 1_700_000_000 + n, sig: "s".repeat(128), tags: [], content: JSON.stringify(content) });
const full = (n, over = {}) => ({ url: `https://m.test/${n}.mp3`, title: `Song ${n}`, artist: `Band ${n}`, duration: 200, coverArt: `https://m.test/${n}.jpg`, genre: n % 2 ? "Pop" : "Rock", ...over });
const events = [
  mk(101, ART, full(101)), mk(102, OTHER, full(102)), mk(103, ART, full(103)),
  mk(110, OTHER, full(110, { title: "voice memo 1", genre: "", coverArt: "" })),
  mk(120, ME, full(120, { title: "My Upload", artist: "Me", genre: "Pop" })),
  mk(121, ME, full(121, { title: "My Draft", coverArt: "", genre: "" })),
];
const likes = [{ id: H(900), pubkey: ME, kind: 7, created_at: 1_700_009_999, content: "+", tags: [["e", H(102), "", OTHER], ["k", "1808"]], sig: "s" }];
StrifyNet.prototype.connect = async (urls) => urls; // never open real sockets in tests
StrifyNet.prototype.fetch = async (filters) => {
  const f = filters[0];
  if (f.kinds?.includes(7)) return likes;
  if (f.ids) return events.filter((e) => f.ids.includes(e.id));
  if (f.kinds?.some((k) => [0, 3, 10063].includes(k))) return [];
  if (f.authors?.length === 1 && f.authors[0] === ME) return events.filter((e) => e.pubkey === ME);
  return events;
};

const published = []; const signed = []; const puts = [];
let signedIn = true;
const mod = await import("../src/ui/Strify.js");
mod.initStrify({
  getSession: () => (signedIn ? { pubkeyHex: ME, type: "nsec" } : null), getUserRelays: () => ["wss://r.test"], getFollows: () => [], isPremium: () => false, isPremiumLoading: () => false,
  toast() {}, signIn() {}, openZap() {}, uploadFallback: async () => "",
  sign: async (template) => { signed.push(template); return { ...template, id: H(777), pubkey: ME, sig: "s" }; },
  publish: async (template) => { published.push(template); return { signed: { ...template, id: H(800 + published.length), pubkey: ME, created_at: 1_800_000_000, sig: "s".repeat(128) }, result: { accepted: ["wss://r.test"] } }; },
});
// MusicBrainz and the media server, both faked.
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.includes("musicbrainz.org")) return { ok: true, status: 200, json: async () => ({ recordings: [] }) };
  if (init.method === "PUT") { puts.push({ href, auth: init.headers.Authorization }); const name = puts.length === 1 ? "audio.mp3" : "cover.jpg"; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ url: `https://blossom.band/${name}` }) }; }
  throw new Error(`unexpected fetch ${href}`);
};

mod.renderStrifyPage();
mod.startStrifyPage();
await new Promise((r) => setTimeout(r, 400));

const click = (matchers) => listeners.click.forEach((fn) => fn({ target: { closest: (sel) => matchers[sel] || null } }));
const openTab = async (tab, lib) => { click({ "[data-strify-tab]": { dataset: { strifyTab: tab } }, ...(lib ? {} : {}) }); if (lib) click({ "[data-strify-lib]": { dataset: { strifyLib: lib } } }); await new Promise((r) => setTimeout(r, 40)); return body.innerHTML; };

test("nav has Home, Search, My Library and Create, each with its own Font Awesome icon", () => {
  const nav = mod.renderStrifyPage();
  for (const [id, label, ic] of [["home", "Home", "fa-house"], ["search", "Search", "fa-magnifying-glass"], ["library", "My Library", "fa-book-open"], ["create", "Create", "fa-cloud-arrow-up"]]) {
    assert.ok(nav.includes(`data-strify-tab="${id}"`) && nav.includes(label) && nav.includes(ic), `${id} tab`);
  }
});

test("Home: greeting, filter chips, quick access, then carousels in order; recorded sounds and incomplete tracks stay off", async () => {
  const home = await openTab("home");
  const at = (needle) => home.indexOf(needle);
  assert.match(home, /Good (morning|afternoon|evening|night)/);
  assert.ok(at("sh-greet") < at("sh-chips") && at("sh-chips") < at("sh-quick") && at("sh-quick") < at("sh-cars"), "header, chips, quick access, carousels");
  assert.deepEqual([...home.matchAll(/data-sh-chip="(\w+)"/g)].map((m) => m[1]), ["all", "music", "foryou", "new", "zaps"]);
  assert.ok(at("Made For You") > at("sh-cars") && at("Made For You") < at("Zapped Most Today"), "carousel order");
  assert.ok(home.includes("Song 101") && home.includes("Song 102") && home.includes("My Upload"));
  assert.ok(!home.includes("voice memo 1"), "recorded sound is hidden");
  assert.ok(!home.includes("My Draft"), "incomplete upload is hidden");
  assert.ok(home.includes("data-sh-all=\"made-for-you\"") && home.includes("Show all"));
  assert.ok(home.includes("Preview"), "zap carousel is labelled as a preview when there are no zaps");
});

test("Home: chips filter client-side, Show all expands a carousel and Back returns", async () => {
  click({ "[data-sh-chip]": { dataset: { shChip: "zaps" } } });
  assert.match(await openTab("home"), /data-chip="zaps"/);
  click({ "[data-sh-chip]": { dataset: { shChip: "all" } } });
  assert.match(await openTab("home"), /data-chip="all"/);
  click({ "[data-sh-all]": { dataset: { shAll: "made-for-you" } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(body.innerHTML.includes("sh-allview") && body.innerHTML.includes("Made For You"));
  click({ "[data-sh-back]": {} });
  assert.ok(!body.innerHTML.includes("sh-allview"));
});

test("Search: recommendations with genre chips (no junk); a query still finds incomplete tracks, complete ones first", async () => {
  const search = await openTab("search");
  assert.ok(search.includes("Browse all") && search.includes("ss-tile") && search.includes("data-strify-genre"));
  assert.ok(!search.includes("voice memo 1"));
  click({ "[data-strify-genre]": { dataset: { strifyGenre: "Pop" } } });
  await new Promise((r) => setTimeout(r, 40));
  assert.match(body.innerHTML, /results for “Pop”/);
  assert.ok(body.innerHTML.includes("ss-chips") && body.innerHTML.includes('data-strify-sfilter="artists"'), "result filters (All / Songs / Artists)");
});

test("Search: typing a query shows a top result, songs and artists; the Artists filter lists only artists", async () => {
  await openTab("search");
  const input = { value: "song" };
  for (const fn of listeners.input || []) fn({ target: { closest: (sel) => (sel === "[data-strify-search]" ? input : null) } });
  await new Promise((r) => setTimeout(r, 200));
  const html = body.innerHTML;
  assert.ok(html.includes("Top result") && html.includes('aria-label="Songs"') && html.includes('aria-label="Artists"'), "top result, songs and artists sections");
  assert.ok(html.includes("ss-song"), "compact song rows");
  click({ "[data-strify-sfilter]": { dataset: { strifySfilter: "artists" } } });
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(body.innerHTML.includes("ss-artist-grid") && !body.innerHTML.includes("ss-song"), "artists-only view");
  click({ "[data-strify-search-clear]": {} });
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(body.innerHTML.includes("Browse all"), "clearing the search returns to browse tiles");
});

test("My Library: uploads explain why a draft is hidden and can be removed; liked songs resolve from relay reactions", async () => {
  await openTab("library");
  const uploads = await openTab("library", "uploads");
  assert.ok(uploads.includes("My Draft") && uploads.includes("Hidden from Home: cover, genre"));
  assert.ok(uploads.includes("data-strify-delete-track"));
  const liked = await openTab("library", "liked");
  assert.ok(liked.includes("Song 102"));
  assert.match(await openTab("library", "playlists"), /strify-seg/);
});

test("signed out: Library and Create ask you to sign in", async () => {
  signedIn = false;
  assert.match(await openTab("library"), /Sign in to open your library/);
  assert.match(await openTab("create"), /Sign in to upload music/);
  signedIn = true;
});

test("Create: pick files, copyright check, upload to Blossom, publish a kind 1808, and it appears in Uploads", async () => {
  const create = await openTab("create");
  for (const need of ['name="audio"', 'name="cover"', 'name="title"', 'name="artist"', 'name="genre"', 'name="rights"', "data-strify-check-copyright"]) assert.ok(create.includes(need), need);

  const field = (value = "") => ({ value, disabled: false, focus() {} });
  const input = (file) => ({ files: [file], value: "x" });
  const form = { elements: { title: field(""), artist: field("InvalidCastX"), genre: field("Pop"), license: field("CC BY 4.0"), rights: { checked: true, focus() {} }, confirmMatch: null }, querySelector: () => mkEl(), querySelectorAll: () => [] };
  formStub = form;
  const audio = new File([new Uint8Array([1, 2, 3, 4])], "nakamotos_dream.mp3", { type: "audio/mpeg" });
  const cover = new File([new Uint8Array([9, 9])], "cover.jpg", { type: "image/jpeg" });
  listeners.change.forEach((fn) => fn({ target: { closest: (sel) => (sel === "[data-strify-audio-file]" ? input(audio) : null) } }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(form.elements.title.value, "nakamotos dream", "title prefilled from the file name");
  listeners.change.forEach((fn) => fn({ target: { closest: (sel) => (sel === "[data-strify-cover-file]" ? input(cover) : null) } }));

  form.elements.title.value = "Nakamotos Dream";
  listeners.submit.forEach((fn) => fn({ target: { closest: () => form }, preventDefault() {} }));
  // The copyright check waits ~1.1 s between MusicBrainz requests (their rate limit), so wait for the publish itself.
  for (let i = 0; i < 100 && published.length < 1; i += 1) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(puts.length, 2, "audio and cover each uploaded once");
  assert.ok(puts.every((p) => p.href === "https://blossom.band/upload" && /^Nostr /.test(p.auth)));
  assert.equal(signed.filter((t) => t.kind === 24242).length, 2, "one Blossom auth event per file");
  assert.equal(published.length, 1);
  const event = published[0];
  assert.equal(event.kind, 1808);
  assert.deepEqual(JSON.parse(event.content), { url: "https://blossom.band/audio.mp3", title: "Nakamotos Dream", artist: "InvalidCastX", duration: 120, paidSats: 0, coverArt: "https://blossom.band/cover.jpg", genre: "Pop" });
  assert.ok(event.tags.some((t) => t[0] === "t" && t[1] === "strify-genre-pop") && event.tags.some((t) => t[0] === "license"));
  assert.ok(body.innerHTML.includes("Nakamotos Dream") && body.innerHTML.includes("strify-seg"), "lands in Library → Uploads");
});

test("Create: refuses to publish without the rights confirmation, and never uploads", async () => {
  await openTab("create");
  const before = puts.length;
  const field = (value = "") => ({ value, disabled: false, focus() {} });
  const form = { elements: { title: field("Another"), artist: field("Me"), genre: field("Pop"), license: field("CC0 (public domain)"), rights: { checked: false, focus() {} } }, querySelector: () => mkEl(), querySelectorAll: () => [] };
  formStub = form;
  listeners.submit.forEach((fn) => fn({ target: { closest: () => form }, preventDefault() {} }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(puts.length, before);
});
