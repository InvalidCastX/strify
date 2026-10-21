// Pure rules for strify's two music feeds, plus catalog search. Authors are matched by hex pubkey, never by display name.
import { dedupeTracks } from "./strify-tracks.js";

const HEX64 = /^[0-9a-f]{64}$/i;
const lower = (v) => String(v || "").toLowerCase();

/** Pubkeys eligible for For You: the signed-in user plus everyone they follow. Empty when signed out. */
export function forYouAuthors(me, follows) {
  const set = new Set();
  if (!HEX64.test(me || "")) return set; // signed out: no For You audience at all
  set.add(lower(me));
  for (const pk of follows || []) if (HEX64.test(pk || "")) set.add(lower(pk));
  return set;
}

const mergePools = (pools, kinds) => dedupeTracks((pools || []).flat().filter((t) => t && (!kinds || kinds.includes(t.kind))));

/** For You = own + followed authors' tracks only, newest first, deduplicated. */
export function forYouFeed({ pools, me, follows, kinds }) {
  const authors = forYouAuthors(me, follows);
  if (!authors.size) return [];
  return mergePools(pools, kinds).filter((t) => authors.has(lower(t.pubkey)));
}

/** Global = every available track from any author (own and followed included), deduplicated. */
export function globalFeed({ pools, kinds }) { return mergePools(pools, kinds); }

/** Names a profile can be found by: only fields the profile really has. */
export function profileSearchNames(profile) {
  if (!profile) return [];
  return [profile.display_name, profile.displayName, profile.name, profile.username, profile.nip05].filter((v) => typeof v === "string" && v.trim());
}

export const normalizeQuery = (q) => String(q || "").trim().toLowerCase().replace(/\s+/g, " ");

/** Case-insensitive partial match on title, artist (tag + profile names) and genre. Every word must match somewhere. */
export function trackMatches(track, query, namesFor = () => []) {
  const q = normalizeQuery(query);
  if (!q) return true;
  const haystack = [track.title, track.artist, track.genre, ...namesFor(track.pubkey)].filter(Boolean).join(" \n ").toLowerCase();
  return q.split(" ").every((word) => haystack.includes(word));
}

export const filterTracks = (tracks, query, namesFor) => (normalizeQuery(query) ? tracks.filter((t) => trackMatches(t, query, namesFor)) : tracks);

/** True when the follow list the app knows differs from the one a feed was built with. */
export function followsDiffer(builtWith, current) {
  const a = new Set([...(builtWith || [])].map(lower)); const b = new Set([...(current || [])].map(lower));
  if (a.size !== b.size) return true;
  for (const pk of b) if (!a.has(pk)) return true;
  return false;
}
