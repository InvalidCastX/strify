// Create tab: validate files, upload them to Blossom (BUD-01/02) with a NIP-96 fallback, and build the kind 1808 event.
// Network, signing and hashing are injected so this stays testable without a browser.
import { UPLOAD, GENRES, AUDIO_HEADER_KIND } from "./strify-config.js";
import { safeHttpsUrl } from "./strify-tracks.js";

const extOf = (name) => (String(name || "").split(".").pop() || "").toLowerCase();
export const formatBytes = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function validateAudioFile(file) {
  if (!file) return "Choose an audio file.";
  const typeOk = UPLOAD.audioTypes.includes(String(file.type || "").toLowerCase());
  const extOk = UPLOAD.audioExtensions.includes(extOf(file.name));
  if (!typeOk && !extOk) return "Use an MP3, M4A, AAC, OGG, OPUS, WAV or FLAC file.";
  if (!file.size) return "That file is empty.";
  if (file.size > UPLOAD.maxAudioBytes) return `Audio files are limited to ${formatBytes(UPLOAD.maxAudioBytes)} (this one is ${formatBytes(file.size)}).`;
  return "";
}

export function validateCoverFile(file) {
  if (!file) return "Choose a cover image.";
  if (!UPLOAD.coverTypes.includes(String(file.type || "").toLowerCase())) return "Cover art must be a JPG, PNG or WebP image.";
  if (file.size > UPLOAD.maxCoverBytes) return `Cover art is limited to ${formatBytes(UPLOAD.maxCoverBytes)}.`;
  return "";
}

const clean = (value, max) => String(value || "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Validate the text fields. Returns { ok, errors, values } where values are trimmed and length-limited. */
export function validateDetails({ title, artist, genre, license }) {
  const values = { title: clean(title, 120), artist: clean(artist, 120), genre: clean(genre, 40), license: clean(license, 60) };
  const errors = {};
  if (values.title.length < 2) errors.title = "Give the song a title.";
  if (values.artist.length < 2) errors.artist = "Add the artist name.";
  if (!values.genre) errors.genre = "Pick a genre.";
  else if (!GENRES.some((g) => g.toLowerCase() === values.genre.toLowerCase()) && !/\p{L}{2}/u.test(values.genre)) errors.genre = "Pick a genre.";
  return { ok: Object.keys(errors).length === 0, errors, values };
}

export const genreSlug = (genre) => String(genre || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);

/** The kind 1808 event, content in the same JSON shape other 1808 players already read. */
export function buildTrackTemplate({ url, coverArt, title, artist, genre, duration, license }) {
  if (!safeHttpsUrl(url) || !safeHttpsUrl(coverArt)) throw new Error("Both the audio and cover URLs must be https.");
  const slug = genreSlug(genre);
  const tags = [...UPLOAD.tags.map((tag) => ["t", tag]), ...(slug ? [["t", `strify-genre-${slug}`]] : [])];
  if (license) tags.push(["license", license]);
  return {
    kind: AUDIO_HEADER_KIND,
    content: JSON.stringify({ url: safeHttpsUrl(url), title, artist, duration: Math.max(0, Math.round(Number(duration) || 0)), paidSats: 0, coverArt: safeHttpsUrl(coverArt), genre }),
    tags,
  };
}

/** License of an existing track event (the `license` tag written by buildTrackTemplate), or "". */
export const licenseOfEvent = (event) => clean((event?.tags || []).find((t) => t?.[0] === "license")?.[1], 60);

/**
 * Kind 1808 events can't be edited in place, so an edit is a new event built from the old one:
 * same audio and duration, new details, and any extra JSON fields or tags the original carried are kept.
 * `track` is the parsed track, `original` the raw event (may be missing), `coverArt` an optional new cover URL.
 */
export function buildEditedTemplate({ track, original, title, artist, genre, license, coverArt }) {
  const base = buildTrackTemplate({ url: track.url, coverArt: coverArt || track.coverArt, title, artist, genre, duration: track.duration, license });
  let previous = {};
  try { const data = JSON.parse(original?.content || ""); if (data && typeof data === "object" && !Array.isArray(data)) previous = data; } catch { /* not JSON */ }
  const managed = (t) => t?.[0] === "license" || (t?.[0] === "t" && (UPLOAD.tags.includes(t[1]) || String(t[1] || "").startsWith("strify-genre-")));
  const extra = (original?.tags || []).filter((t) => Array.isArray(t) && t.length && !managed(t));
  return { kind: base.kind, content: JSON.stringify({ ...previous, ...JSON.parse(base.content) }), tags: [...base.tags, ...extra] };
}

// ── Hashing and Blossom ────────────────────────────────────────────
export async function sha256Hex(file, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("This browser can't hash files (needs a secure https page).");
  const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const base64Utf8 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = ""; for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

const trimSlash = (url) => String(url || "").replace(/\/+$/, "");

/** Upload one file to one Blossom server. Resolves with { url, sha256, server } or throws a readable error. */
export async function blossomUpload({ server, file, sign, fetchImpl = globalThis.fetch, hash, now = Math.floor(Date.now() / 1000) }) {
  const base = trimSlash(server);
  const sha256 = hash || (await sha256Hex(file));
  const auth = await sign({
    kind: 24242, created_at: now, content: "Upload",
    tags: [["t", "upload"], ["x", sha256], ["expiration", String(now + UPLOAD.authTtlSeconds)]],
  });
  const response = await fetchImpl(`${base}/upload`, {
    method: "PUT",
    headers: { Authorization: `Nostr ${base64Utf8(JSON.stringify(auth))}`, "Content-Type": file.type || "application/octet-stream", "X-SHA-256": sha256 },
    body: file,
  });
  if (!response.ok) {
    const reason = response.headers?.get?.("x-reason");
    let detail = "";
    try { detail = (await response.text()).slice(0, 160); } catch { /* no body */ }
    throw new Error(`${new URL(base).hostname}: ${reason || detail || `upload failed (${response.status})`}`);
  }
  let body;
  try { body = await response.json(); } catch { throw new Error(`${new URL(base).hostname} sent an unreadable response.`); }
  const url = safeHttpsUrl(body?.url);
  if (!url) throw new Error(`${new URL(base).hostname} didn't return an https URL.`);
  if (body.sha256 && String(body.sha256).toLowerCase() !== sha256) throw new Error(`${new URL(base).hostname} stored a different file (hash mismatch).`);
  return { url, sha256, server: base };
}

/**
 * Try each Blossom server in turn, then the NIP-96 fallback (only for files it accepts).
 * `onTry(label)` lets the UI say where it is uploading.
 */
export async function uploadFile({ file, servers, sign, fetchImpl, fallback, onTry = () => {} }) {
  const errors = [];
  const hash = await sha256Hex(file);
  for (const server of [...new Set((servers || []).map(trimSlash).filter((s) => safeHttpsUrl(s)))]) {
    onTry(new URL(server).hostname);
    try { return await blossomUpload({ server, file, sign, fetchImpl, hash }); } catch (error) { errors.push(error?.message || String(error)); }
  }
  if (fallback && file.size <= UPLOAD.nostrBuildMaxBytes) {
    onTry("nostr.build");
    try { const url = safeHttpsUrl(await fallback(file)); if (url) return { url, sha256: hash, server: "https://nostr.build" }; errors.push("nostr.build didn't return an https URL."); }
    catch (error) { errors.push(error?.message || String(error)); }
  }
  throw new Error(`Couldn't upload ${file.name || "the file"}. ${errors.join(" · ")}`.slice(0, 400));
}

/** Servers from a kind 10063 event ("server" tags), https only. */
export function serversFromEvent(event) {
  if (!event || event.kind !== 10063) return [];
  return (event.tags || []).filter((t) => t?.[0] === "server" && safeHttpsUrl(t[1])).map((t) => trimSlash(safeHttpsUrl(t[1])));
}
