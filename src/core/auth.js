// Login: a NIP-07 browser extension (Alby, nos2x, …) or a pasted nsec. Logging in is optional:
// without a session strify is a read-only music explorer.
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { decodeNsec, getPublicKeyHex, hexToBytes, isValidHex64 } from "./nostr-core.js";

// nostr-core.js and Strify.js look for window.NostrTools; it is bundled here instead of loaded from a CDN.
if (typeof window !== "undefined") window.NostrTools = { finalizeEvent, getPublicKey, nip19 };

const SESSION_KEY = "strify_session"; // sessionStorage: cleared when the tab closes
const REMEMBER_KEY = "strify_session_persist"; // localStorage: extension logins always, nsec only if the user opts in

export async function ensureNostrTools() { return window.NostrTools; }

/**
 * A signer is either:
 *   { type: "nsec", privateKeyHex, pubkeyHex }  — signs locally
 *   { type: "nip07", pubkeyHex }                 — delegates to a browser extension
 */
export async function nsecSignIn(nsecInput) {
  const privateKeyHex = decodeNsec(nsecInput);
  if (!privateKeyHex) return { error: "That doesn't look like a valid nsec1… key." };
  let pubkeyHex;
  try { pubkeyHex = getPublicKeyHex(privateKeyHex); }
  catch (e) { return { error: e.message || "Couldn't derive a public key from that nsec." }; }
  if (!isValidHex64(pubkeyHex)) return { error: "Couldn't derive a valid public key from that nsec." };
  return { signer: { type: "nsec", privateKeyHex, pubkeyHex } };
}

export async function nip07SignIn() {
  if (!window.nostr?.getPublicKey) return { error: "No Nostr extension (like Alby or nos2x) was found in this browser." };
  try {
    const pubkeyHex = await window.nostr.getPublicKey();
    if (!isValidHex64(pubkeyHex)) return { error: "The extension returned an invalid public key." };
    return { signer: { type: "nip07", pubkeyHex } };
  } catch (e) {
    return { error: e?.message || "The extension declined the connection." };
  }
}

/** Sign an event template with the active signer. Fills created_at/tags defaults. */
export async function signEvent(templateIn, signer) {
  if (!signer) throw new Error("Not signed in.");
  const template = { created_at: Math.floor(Date.now() / 1000), tags: [], ...templateIn };
  if (signer.type === "nip07") {
    if (!window.nostr?.signEvent) throw new Error("The Nostr extension is no longer available.");
    return window.nostr.signEvent({ ...template, pubkey: signer.pubkeyHex });
  }
  const bytes = new Uint8Array(hexToBytes(signer.privateKeyHex));
  return finalizeEvent(template, bytes);
}

export function saveSession(signer, { remember = false } = {}) {
  const payload = JSON.stringify(signer);
  sessionStorage.setItem(SESSION_KEY, payload);
  if (remember) { localStorage.setItem(SESSION_KEY, payload); localStorage.setItem(REMEMBER_KEY, "1"); }
  else clearRememberedSession();
}

export function loadSession() {
  try {
    const fromSession = sessionStorage.getItem(SESSION_KEY);
    if (fromSession) return JSON.parse(fromSession);
    if (localStorage.getItem(REMEMBER_KEY) === "1") {
      const fromLocal = localStorage.getItem(SESSION_KEY);
      if (fromLocal) return JSON.parse(fromLocal);
    }
  } catch { /* ignore malformed session data */ }
  return null;
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  clearRememberedSession();
}
function clearRememberedSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(REMEMBER_KEY);
}
