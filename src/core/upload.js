// Last-resort file host (NIP-96 on nostr.build), used when no Blossom server accepts an upload.
import { signEvent } from "./auth.js";

const NOSTR_BUILD_UPLOAD_URL = "https://nostr.build/api/v2/nip96/upload";

export async function uploadNostrBuildFile(file, session) {
  const authEvent = await signEvent({ kind: 27235, tags: [["u", NOSTR_BUILD_UPLOAD_URL], ["method", "POST"]], content: "" }, session);
  const body = new FormData();
  body.append("file", file, file.name);
  const response = await fetch(NOSTR_BUILD_UPLOAD_URL, { method: "POST", headers: { Authorization: `Nostr ${btoa(JSON.stringify(authEvent))}` }, body });
  const responseText = await response.text();
  let result;
  try { result = JSON.parse(responseText); }
  catch { throw new Error(response.ok ? "nostr.build returned an unreadable upload response." : `Upload failed (${response.status}).`); }
  if (!response.ok) throw new Error(result.message || result.error || `Upload failed (${response.status}).`);
  if (result.status === "error") throw new Error(result.message || "nostr.build could not upload this file.");
  const mediaEvent = result.nip94_event || result.data?.nip94_event;
  const mediaUrl = mediaEvent?.tags?.find((tag) => tag[0] === "url")?.[1] || result.url || result.data?.url;
  let parsedUrl;
  try { parsedUrl = new URL(mediaUrl); } catch { throw new Error("nostr.build did not return a valid media URL."); }
  if (parsedUrl.protocol !== "https:") throw new Error("nostr.build returned an insecure media URL.");
  return parsedUrl;
}
