// "Is this really a song?" Home and recommendations only show tracks that carry the metadata a real release has:
// a real title, an artist, cover art, a genre and a song-length duration. Anything else (a voice memo, a sound
// clip, an untagged file) stays reachable through Search and the artist's own page, but never headlines Home.
import { QUALITY } from "./strify-config.js";
import { safeHttpsUrl } from "./strify-tracks.js";

const GENERIC_TITLE = /^(untitled(?: track)?|no title|recording|new recording|voice(?: memo| note| message)?|audio|sound|noise|track|test|testing|demo|sample|unknown|clip|memo|file)[\s_.-]*\d*$/i;
const FILE_LIKE = /\.(mp3|wav|m4a|ogg|opus|flac|aac|mp4|webm)$/i;
const HASH_LIKE = /^[0-9a-f]{12,}$/i;
const GENERIC_ARTIST = /^(unknown(?: artist)?|various(?: artists)?|n\/a|none|null|anonymous|artist)$/i;

const letters = (value) => (String(value || "").match(/\p{L}/gu) || []).length;

/** { ok, missing } — `missing` names every field that kept the track off Home (for the Uploads list to explain). */
export function assessTrack(track) {
  const missing = [];
  const title = String(track?.title || "").trim();
  const artist = String(track?.artist || "").trim();
  const genre = String(track?.genre || "").trim();
  if (!title || GENERIC_TITLE.test(title) || FILE_LIKE.test(title) || HASH_LIKE.test(title) || letters(title) < 1) missing.push("title");
  if (!artist || GENERIC_ARTIST.test(artist) || letters(artist) < 1) missing.push("artist");
  if (!safeHttpsUrl(track?.coverArt)) missing.push("cover");
  if (!genre || letters(genre) < 2) missing.push("genre");
  const seconds = Number(track?.duration) || 0;
  if (!track?.url) missing.push("audio");
  if (seconds < QUALITY.minSeconds || seconds > QUALITY.maxSeconds) missing.push("duration");
  return { ok: missing.length === 0, missing };
}

export const isRealMusic = (track) => assessTrack(track).ok;
export const filterRealMusic = (tracks) => (tracks || []).filter(isRealMusic);
