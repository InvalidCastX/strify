// Pre-upload copyright check. Honest scope: this is a *metadata* check, not audio fingerprinting.
//   1. Nostr: is a song with the same title and artist already published by a different account?
//   2. MusicBrainz: does a released recording with this title exist (and by whom)?
// Anything found is shown to the uploader, who must confirm they own the song or have permission. A clean result
// is not clearance: it only means these two sources had no match.
const MB_URL = "https://musicbrainz.org/ws/2/recording";

export function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\((?:[^)]*)\)|\[(?:[^\]]*)\]/g, " ")                       // (feat. x) [remix]
    .replace(/\s[-–—]\s(?:remaster(?:ed)?|live|radio edit|acoustic|remix|version|mono|stereo).*$/i, " ")
    .replace(/\b(?:feat|ft|featuring)\.?\s.*$/i, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().replace(/\s+/g, " ");
}

const luceneSafe = (value) => String(value || "").replace(/["\\+\-!(){}\[\]^~*?:/&|]/g, " ").replace(/\s+/g, " ").trim();

/** Same song (title + artist) already published by someone else on Nostr, from the tracks already loaded. */
export function nostrDuplicates(tracks, { title, artist, me }) {
  const wantTitle = normalizeText(title); const wantArtist = normalizeText(artist);
  if (!wantTitle) return [];
  return (tracks || [])
    .filter((t) => t.pubkey !== me && normalizeText(t.title) === wantTitle && (!wantArtist || normalizeText(t.artist) === wantArtist))
    .slice(0, 3)
    .map((t) => ({ source: "nostr", title: t.title, artist: t.artist || "another account", detail: "Already published on Nostr by another account", pubkey: t.pubkey }));
}

/** Pure: turn MusicBrainz result lists into matches. A match needs an equal normalized title and at least one release. */
export function musicBrainzMatches(recordings, { title, artist }) {
  const wantTitle = normalizeText(title); const wantArtist = normalizeText(artist);
  const seen = new Set(); const out = [];
  for (const rec of recordings || []) {
    if (normalizeText(rec?.title) !== wantTitle || Number(rec?.score) < 90) continue;
    if (!(rec.releases?.length || rec.isrcs?.length)) continue;
    const credit = (rec["artist-credit"] || []).map((c) => c?.name || c?.artist?.name || "").join("").trim() || "an artist";
    const same = !!wantArtist && normalizeText(credit) === wantArtist;
    const id = `${normalizeText(credit)}|${wantTitle}`;
    if (seen.has(id)) continue; seen.add(id);
    const release = rec.releases?.[0];
    out.push({
      source: "musicbrainz", title: rec.title, artist: credit, sameArtist: same,
      detail: `${same ? "Released under the same artist name" : "Released by a different artist"}${release?.title ? ` on “${release.title}”` : ""}${release?.date ? ` (${String(release.date).slice(0, 4)})` : ""}`,
      url: `https://musicbrainz.org/recording/${encodeURIComponent(rec.id || "")}`,
    });
    if (out.length >= 5) break;
  }
  return out;
}

async function queryMusicBrainz(query, fetchImpl) {
  const response = await fetchImpl(`${MB_URL}?query=${encodeURIComponent(query)}&fmt=json&limit=25`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`MusicBrainz ${response.status}`);
  const data = await response.json();
  return Array.isArray(data?.recordings) ? data.recordings : [];
}

/**
 * Returns { verdict, matches, checked }.
 *   verdict "clear"       – no match found in the sources that answered
 *   verdict "review"      – matches found: the uploader must confirm ownership or permission
 *   verdict "unavailable" – nothing could be checked (offline / rate-limited); ownership confirmation still applies
 */
export async function checkCopyright({ title, artist, me, knownTracks = [], fetchImpl = globalThis.fetch, pauseMs = 1100, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const matches = nostrDuplicates(knownTracks, { title, artist, me });
  let answered = 0; let failed = 0;
  const t = luceneSafe(title); const a = luceneSafe(artist);
  const queries = [`recording:"${t}"`, ...(a ? [`recording:"${t}" AND artist:"${a}"`] : [])];
  const recordings = [];
  for (let i = 0; i < queries.length; i += 1) {
    if (i) await sleep(pauseMs); // MusicBrainz allows about one request per second
    try { recordings.push(...(await queryMusicBrainz(queries[i], fetchImpl))); answered += 1; } catch { failed += 1; }
  }
  const unique = new Map(recordings.map((r) => [r.id || `${r.title}|${r["artist-credit"]?.[0]?.name}`, r]));
  matches.push(...musicBrainzMatches([...unique.values()], { title, artist }));
  if (matches.length) return { verdict: "review", matches, checked: answered > 0 };
  if (!answered && failed) return { verdict: "unavailable", matches: [], checked: false };
  return { verdict: "clear", matches: [], checked: true };
}
