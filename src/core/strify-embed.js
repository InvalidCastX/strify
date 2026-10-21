// DOM-free helpers for recognising a shared strify playlist inside a kind 1 note.
import { PLAYLIST_KIND, PLAYLIST_D_PREFIX } from "./strify-config.js";
const escapeHtml = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const HEX64 = /^[0-9a-f]{64}$/i;

export function playlistCoordinateFromTags(tags) {
  for (const tag of tags || []) {
    if (tag?.[0] !== "a") continue;
    const [kind, pubkey, ...rest] = String(tag[1] || "").split(":");
    const d = rest.join(":");
    if (Number(kind) === PLAYLIST_KIND && HEX64.test(pubkey || "") && d.startsWith(PLAYLIST_D_PREFIX)) return { coord: tag[1], pubkey: pubkey.toLowerCase(), d, relay: /^wss:\/\//.test(tag[2] || "") ? tag[2] : "" };
  }
  return null;
}

/** Placeholder hydrated at runtime by src/ui/Strify.js once the playlist event has been fetched. */
export function renderPlaylistEmbedPlaceholder(tags) {
  const info = playlistCoordinateFromTags(tags);
  if (!info) return "";
  const E = escapeHtml;
  return `<div class="strify-embed" data-strify-playlist="${E(info.coord)}" data-strify-pubkey="${E(info.pubkey)}" data-strify-d="${E(info.d)}" data-strify-relay="${E(info.relay)}"><div class="strify-embed-inner"><div class="strify-state strify-state-loading"><i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i><span>Loading playlist…</span></div></div></div>`;
}
