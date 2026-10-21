// Who the signed-in user follows, for strify's For You mix.
// Order of preference: the list the app already loaded (no network), then ask the user's relays.
const HEX64 = /^[0-9a-f]{64}$/i;

const cleanList = (list) => [...new Set((list || []).filter((k) => HEX64.test(k || "")).map((k) => k.toLowerCase()))];

/**
 * known:       follow list the app already has (may be empty/unknown)
 * fetchEvents: (filters) => events, asked only when `known` has nothing
 * Returns { follows, state } where state is:
 *   "found" – a usable list (from the app or a relay)
 *   "empty" – a follow list exists but follows nobody
 *   "none"  – no follow list was found on any relay that answered
 * A relay failure throws, so the caller can show a real error instead of "none".
 */
export async function resolveFollows({ me, known, fetchEvents }) {
  const fromApp = cleanList(known);
  if (fromApp.length) return { follows: fromApp, state: "found" };
  const events = await fetchEvents([{ kinds: [3], authors: [me], limit: 5 }]);
  const latest = (events || []).filter((e) => e?.kind === 3 && e.pubkey === me).sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return { follows: [], state: "none" };
  const follows = cleanList((latest.tags || []).filter((t) => t[0] === "p").map((t) => t[1]));
  return { follows, state: follows.length ? "found" : "empty" };
}
