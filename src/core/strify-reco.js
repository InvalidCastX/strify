// Recommendations for the Search tab. Deterministic and local: it only reorders music that has already been
// loaded from the user's relays, using what the person played and liked on this device.
import { filterRealMusic } from "./strify-quality.js";
import { LIBRARY } from "./strify-config.js";

const norm = (value) => String(value || "").trim().toLowerCase();

export function topGenres(tracks, limit = 8) {
  const counts = new Map();
  for (const track of tracks || []) {
    const key = norm(track.genre);
    if (!key) continue;
    const entry = counts.get(key) || { genre: track.genre.trim(), count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre)).slice(0, limit);
}

function taste(listened) {
  const genres = new Map(); const artists = new Map();
  for (const track of listened) {
    if (norm(track.genre)) genres.set(norm(track.genre), (genres.get(norm(track.genre)) || 0) + 1);
    artists.set(track.pubkey, (artists.get(track.pubkey) || 0) + 1);
  }
  const best = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  return { genre: best(genres), artist: best(artists) };
}

/**
 * Sections of { id, title, tracks }. A track appears in at most one section; empty sections are dropped.
 *   because-genre  – the genre you play/like most
 *   more-artist    – other songs by the artist you play/like most
 *   follows        – real music from accounts you follow
 *   fresh          – newest music from everyone
 */
export function recommend({ catalog, recent = [], liked = [], follows = new Set(), me = "", limit = LIBRARY.shelfSize } = {}) {
  const real = filterRealMusic(catalog);
  const listened = [...recent, ...liked];
  const heard = new Set(listened.map((track) => track.key));
  const { genre, artist } = taste(listened);
  const used = new Set();
  const take = (candidates) => {
    const picked = [];
    for (const track of candidates) {
      if (picked.length >= limit) break;
      if (used.has(track.key) || heard.has(track.key) || track.pubkey === me) continue;
      used.add(track.key); picked.push(track);
    }
    return picked;
  };
  const sections = [];
  const add = (id, title, tracks) => { if (tracks.length) sections.push({ id, title, tracks }); };
  if (artist) {
    const name = listened.find((track) => track.pubkey === artist)?.artist || "";
    add("more-artist", name ? `More from ${name}` : "More from artists you play", take(real.filter((track) => track.pubkey === artist)));
  }
  if (genre) {
    const label = listened.find((track) => norm(track.genre) === genre)?.genre || genre;
    add("because-genre", `Because you like ${label}`, take(real.filter((track) => norm(track.genre) === genre)));
  }
  if (follows.size) add("follows", "From people you follow", take(real.filter((track) => follows.has(track.pubkey))));
  add("fresh", "Fresh on Nostr", take(real));
  return sections;
}
