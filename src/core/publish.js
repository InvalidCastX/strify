// Publishing goes only to the relays marked "write". Sockets are opened on demand and closed when idle.
import { RelayManager, publishAndConfirm } from "./nostr-core.js";
import { signEvent } from "./auth.js";
import { writeRelays } from "./relays.js";

const IDLE_MS = 60_000;
const PUBLISH_TIMEOUT = 8000;
let rm = null;
let idleTimer = null;

function manager() {
  const urls = writeRelays();
  const same = rm && rm.relayUrls.length === urls.length && urls.every((u) => rm.relayUrls.includes(u));
  if (!same) { rm?.closeAll(); rm = new RelayManager(urls); }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { rm?.closeAll(); rm = null; }, IDLE_MS);
  return rm;
}

/** Sign `template` and publish it to every write relay. Resolves { signed, result: { accepted, rejected, pending } }. */
export async function publishEvent(template, session) {
  if (!session) throw new Error("Log in to publish.");
  if (!writeRelays().length) throw new Error("No relay is set to write. Turn on “write” for at least one relay in Relays.");
  const signed = await signEvent(template, session);
  const result = await publishAndConfirm(manager(), signed, { timeout: PUBLISH_TIMEOUT });
  return { signed, result };
}
