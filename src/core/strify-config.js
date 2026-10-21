// strify — single place for kinds, relays and tier limits.
export const AUDIO_HEADER_KIND = 1808;
export const AUDIO_TRACK_KIND = 31337;
export const PLAYLIST_KIND = 30078;
export const DELETION_KIND = 5;
export const COMMENT_KIND = 1111;
export const REPOST_KIND = 16; // NIP-18 generic repost, used for non-kind-1 targets

export const PLAYLIST_D_PREFIX = "strify:playlist:";
export const PLAYLIST_T_TAG = "strify-playlist";
export const PLAYLIST_SCHEMA_VERSION = 1;

// Tier limits. Edit here only; the UI and the playlist logic both read this object.
export const PLAYLIST_LIMITS = Object.freeze({
  free: Object.freeze({ maxPlaylists: 1, maxTracksPerPlaylist: 12 }),
  premium: Object.freeze({ maxPlaylists: 10, maxTracksPerPlaylist: 20 }),
});

export function limitsFor(isPremium) {
  return isPremium ? PLAYLIST_LIMITS.premium : PLAYLIST_LIMITS.free;
}

// Kinds listed on Home and Search. Kind 31337 is still parsed for playlists and shared posts;
// add AUDIO_TRACK_KIND here to list those tracks there too.
export const FEED_KINDS = Object.freeze([AUDIO_HEADER_KIND]);

export const DISCOVERY = Object.freeze({
  perKindLimit: 120,
  fetchTimeout: 6000,
  maxWavlakeResolutions: 60,
  wavlakeApi: "https://wavlake.com/api/v1/content/track/",
});

export const PLAYLIST_FIELDS = Object.freeze({ name: 80, description: 500 });

// Strict "this is a real song" filter used by Home and recommendations (see strify-quality.js).
export const QUALITY = Object.freeze({ minSeconds: 30, maxSeconds: 2 * 60 * 60 });

// Create tab: where files go and what is accepted. Blossom servers are tried in order (the account's own
// kind 10063 server list goes first); nostr.build (NIP-96) is the last-resort fallback for files under its free limit.
export const UPLOAD = Object.freeze({
  blossomServers: Object.freeze(["https://blossom.band", "https://blossom.primal.net"]),
  maxAudioBytes: 30 * 1024 * 1024,
  maxCoverBytes: 5 * 1024 * 1024,
  nostrBuildMaxBytes: 20 * 1024 * 1024,
  audioTypes: Object.freeze(["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/opus", "audio/wav", "audio/x-wav", "audio/wave", "audio/flac", "audio/x-flac", "audio/webm"]),
  audioExtensions: Object.freeze(["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac", "webm"]),
  coverTypes: Object.freeze(["image/jpeg", "image/png", "image/webp"]),
  // Hashtags added to every published track. Add e.g. "bch-radio-track" here to also feed other apps' tag searches.
  tags: Object.freeze(["strify-track", "music"]),
  authTtlSeconds: 600,
});

export const GENRES = Object.freeze(["Pop", "Rock", "Hip-Hop", "R&B", "Electronic", "Dance", "House", "Techno", "Ambient", "Lo-fi", "Jazz", "Blues", "Classical", "Country", "Folk", "Reggae", "Latin", "Metal", "Punk", "Indie", "Soul", "Funk", "Gospel", "Soundtrack", "Experimental", "Other"]);

export const LIBRARY = Object.freeze({ historyMax: 30, likesLimit: 200, shelfSize: 12 });

export const LICENSES = Object.freeze(["All rights reserved (my own work)", "CC BY 4.0", "CC BY-SA 4.0", "CC BY-NC 4.0", "CC0 (public domain)"]);
