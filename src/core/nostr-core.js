// ─────────────────────────────────────────────────────────────────
// Core Nostr primitives used by Friendstr.
// This file intentionally keeps the same algorithms as the classic
// utils.js (bech32 codec, RelayManager) rather than reimplementing
// them — only the DOM-coupled and posting/login-only code was cut.
// ─────────────────────────────────────────────────────────────────

export const KNOWN_KINDS = {
  0: "Profile Metadata",
  1: "Note",
  3: "Follow List",
  5: "Deletion Request",
  6: "Repost",
  7: "Reaction",
  8: "Badge Award",
  16: "Generic Repost",
  1984: "Report",
  9734: "Zap Request",
  9735: "Zap Receipt",
  10000: "Mute List",
  10001: "Pin List",
  10002: "Relay List (NIP-65)",
  30008: "Profile Badges",
  30023: "Long-form Article",
  30024: "Draft Article",
  30078: "App Data",
};

// The kinds fetched for the "full account event history" timeline.
export const HISTORY_KINDS = [1, 6, 7, 16, 9735, 30023];

export const KIND_GROUPS = {
  1: { label: "Notes", color: "var(--color-cyan)" },
  6: { label: "Reposts", color: "var(--color-orange)" },
  16: { label: "Reposts", color: "var(--color-orange)" },
  7: { label: "Reactions", color: "var(--color-pink)" },
  9735: { label: "Zaps", color: "var(--color-yellow)" },
  30023: { label: "Articles", color: "var(--color-purple)" },
};

/** NIP-01/33 replaceability class for a kind number. */
export function classifyKind(kind) {
  if (kind === 0 || kind === 3) return "Replaceable";
  if (kind >= 30000 && kind < 40000) return "Addressable";
  if (kind >= 20000 && kind < 30000) return "Ephemeral";
  if (kind >= 10000 && kind < 20000) return "Replaceable";
  return "Regular";
}
/** True if publishing a new event of this kind truly replaces the old one (vs. Nostr's normal immutability). */
export function isReplaceableKind(kind) {
  const c = classifyKind(kind);
  return c === "Replaceable" || c === "Addressable";
}

// ── bech32 (BIP-173) — minimal codec used for npub/note/nevent/nprofile/naddr ──
const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_ALPHABET_MAP = {};
for (let i = 0; i < BECH32_ALPHABET.length; i++) BECH32_ALPHABET_MAP[BECH32_ALPHABET[i]] = i;
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const HEX_CHARS = "0123456789abcdef";

function bech32Polymod(values) {
  let chk = 1;
  for (let i = 0; i < values.length; i++) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ values[i];
    for (let j = 0; j < 5; j++) if ((top >> j) & 1) chk ^= BECH32_GENERATOR[j];
  }
  return chk;
}
function bech32HRPExpand(hrp) {
  const r = [];
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) >> 5);
  r.push(0);
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) & 31);
  return r;
}
function bech32Decode(str) {
  str = String(str || "").trim();
  // Bech32 must not be mixed-case; all-uppercase is valid and decodes the same as lowercase.
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null;
  str = str.toLowerCase();
  const sep = str.lastIndexOf("1");
  if (sep < 1 || sep + 7 > str.length) return null;
  const hrp = str.substring(0, sep), data = str.substring(sep + 1), vals = [];
  for (let i = 0; i < data.length; i++) {
    if (!(data[i] in BECH32_ALPHABET_MAP)) return null;
    vals.push(BECH32_ALPHABET_MAP[data[i]]);
  }
  const comb = bech32HRPExpand(hrp).concat(vals);
  if (bech32Polymod(comb) !== 1) return null;
  const bytes = convertBits(vals.slice(0, -6), 5, 8, false);
  if (!bytes) return null;
  return { hrp, bytes };
}
export function decodeLnurl(input) {
  const decoded = bech32Decode(String(input || "").trim().toLowerCase());
  if (!decoded || decoded.hrp !== "lnurl") return null;
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(decoded.bytes));
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
function bech32Encode(hrp, data) {
  const combined = bech32HRPExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const polymod = bech32Polymod(combined) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((polymod >> (5 * (5 - i))) & 31);
  return hrp + "1" + data.map((v) => BECH32_ALPHABET[v]).join("") + checksum.map((v) => BECH32_ALPHABET[v]).join("");
}
function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const ret = [], maxv = (1 << toBits) - 1, maxAcc = (1 << (fromBits + toBits - 1)) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) return null;
    acc = ((acc << fromBits) | value) & maxAcc;
    bits += fromBits;
    while (bits >= toBits) { bits -= toBits; ret.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits > 0) ret.push((acc << (toBits - bits)) & maxv); }
  else if (bits >= fromBits || (acc << (toBits - bits)) & maxv) return null;
  return ret;
}
export function hexToBytes(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substring(i, i + 2), 16));
  return bytes;
}
export function bytesToHex(bytes) {
  let h = "";
  for (let i = 0; i < bytes.length; i++) { h += HEX_CHARS[(bytes[i] >> 4) & 0xf]; h += HEX_CHARS[bytes[i] & 0xf]; }
  return h;
}
export function isValidHex64(s) {
  return typeof s === "string" && /^[0-9a-fA-F]{64}$/.test(s);
}

export function npubFromHex(pubkeyHex) {
  if (!isValidHex64(pubkeyHex)) return "";
  try {
    if (typeof window !== "undefined" && window.NostrTools?.nip19?.npubEncode) {
      return window.NostrTools.nip19.npubEncode(pubkeyHex.toLowerCase());
    }
  } catch { /* fall through to manual codec */ }
  const words = convertBits(hexToBytes(pubkeyHex.toLowerCase()), 8, 5, true);
  return words ? bech32Encode("npub", words) : "";
}

function decodeNpub(s) {
  const d = bech32Decode(s);
  if (!d || d.hrp !== "npub" || d.bytes.length !== 32) return null;
  return bytesToHex(d.bytes);
}

/** Decode an nsec1… string to a 64-char hex private key, or null if invalid. */
export function decodeNsec(input) {
  const t = (input || "").trim();
  if (!t) return null;
  try {
    if (typeof window !== "undefined" && window.NostrTools?.nip19?.decode) {
      const { type, data } = window.NostrTools.nip19.decode(t);
      if (type === "nsec") {
        const hex = typeof data === "string" ? data : bytesToHex(Array.from(data));
        if (isValidHex64(hex)) return hex;
      }
    }
  } catch { /* fall through to manual codec */ }
  const d = bech32Decode(t);
  if (!d || d.hrp !== "nsec" || d.bytes.length !== 32) return null;
  return bytesToHex(d.bytes);
}

/** Derive the hex public key for a hex private key, via nostr-tools (no manual secp256k1 fallback). */
export function getPublicKeyHex(privateKeyHex) {
  const NT = typeof window !== "undefined" ? window.NostrTools : null;
  if (!NT?.getPublicKey) throw new Error("nostr-tools isn't loaded, so a public key can't be derived.");
  try {
    return NT.getPublicKey(privateKeyHex);
  } catch {
    return NT.getPublicKey(new Uint8Array(hexToBytes(privateKeyHex)));
  }
}
function decodeTlvPubkeyPayload(s, hrp) {
  const d = bech32Decode(s);
  if (!d || d.hrp !== hrp || d.bytes.length < 32) return null;
  const pubkey = bytesToHex(d.bytes.slice(0, 32));
  const tlvs = [];
  let idx = 32;
  while (idx < d.bytes.length) {
    if (idx + 2 > d.bytes.length) break;
    const t = d.bytes[idx], l = d.bytes[idx + 1];
    idx += 2;
    if (idx + l > d.bytes.length) break;
    tlvs.push({ type: t, value: d.bytes.slice(idx, idx + l) });
    idx += l;
  }
  const hints = tlvs.filter((t) => t.type === 1).map((t) => new TextDecoder().decode(new Uint8Array(t.value)));
  return { pubkey, relayHints: hints };
}

/**
 * Parse any account identifier a user might paste: hex pubkey, npub1…,
 * nprofile1…, or a nostr: URI wrapping either. Returns { pubkey, relayHints }
 * or { error }.
 */
export function parseAccountIdentifier(input) {
  const t = (input || "").trim().replace(/^nostr:/i, "");
  if (!t) return { error: "Enter an npub or hex pubkey." };
  if (isValidHex64(t)) return { pubkey: t.toLowerCase(), relayHints: [] };
  if (/^npub1/i.test(t)) {
    const pubkey = decodeNpub(t);
    return pubkey ? { pubkey, relayHints: [] } : { error: "That npub doesn't look valid." };
  }
  if (/^nprofile1/i.test(t)) {
    const r = decodeTlvPubkeyPayload(t, "nprofile");
    return r ? { pubkey: r.pubkey, relayHints: r.relayHints } : { error: "That nprofile doesn't look valid." };
  }
  return { error: "Enter a valid npub1… or 64-character hex pubkey." };
}

// ── Relay health memory ────────────────────────────────────────────
// Shared across every RelayManager in the session (each route creates a new one),
// so the app remembers which relays answered quickly and which just failed, and
// stops paying for repeated dead connections.
const RELAY_COOLDOWN_MS = 5 * 60 * 1000;
export const relayHealth = new Map();

export function recordRelayOutcome(url, ok, ms = 0) {
  const entry = relayHealth.get(url) || { ms: 0, failedAt: 0, failures: 0 };
  if (ok) { entry.ms = entry.ms ? Math.round(entry.ms * 0.6 + ms * 0.4) : ms; entry.failures = 0; entry.failedAt = 0; }
  else { entry.failures += 1; entry.failedAt = Date.now(); }
  relayHealth.set(url, entry);
}

export function isRelayCoolingDown(url, now = Date.now()) {
  const entry = relayHealth.get(url);
  return !!entry && entry.failedAt > 0 && now - entry.failedAt < RELAY_COOLDOWN_MS;
}

/** Order candidate relays: known-fast first, unknown next, recently-failed excluded. */
export function rankRelays(urls) {
  return [...new Set(urls)]
    .filter((url) => !isRelayCoolingDown(url))
    .sort((a, b) => (relayHealth.get(a)?.ms || 1500) - (relayHealth.get(b)?.ms || 1500));
}

// ── Relay WebSocket manager ──
// Data-saver by design: only the relays a request actually needs are opened. Callers
// start with one relay and call widen() when its answer is incomplete.
export class RelayManager {
  constructor(urls, { onStatusChange } = {}) {
    this.relayUrls = [...new Set((urls || []).filter((u) => /^wss:\/\//i.test(u)))];
    this.connections = new Map();
    this.subscriptions = new Map();
    this.subIdCounter = 0;
    this.status = new Map();
    this.onStatusChange = onStatusChange || null;
    this.onEvent = null;
    this.onEOSE = null;
  }
  getNextSubId() { return "sub_" + ++this.subIdCounter; }
  setStatus(url, patch) {
    const cur = this.status.get(url) || { status: "pending", events: 0, errors: 0 };
    const next = { ...cur, ...patch };
    this.status.set(url, next);
    this.onStatusChange?.(url, next);
  }
  async connectAll(ms = 8000) {
    await Promise.allSettled(this.relayUrls.map((u) => this.connect(u, ms)));
  }
  async connectFirst(limit = 3, ms = 3000) {
    const urls = this.relayUrls.slice(0, limit);
    if (!urls.length) return 0;
    return new Promise((resolve) => {
      let settled = 0;
      let connected = 0;
      for (const url of urls) {
        this.connect(url, ms).then(() => {
          connected++;
          resolve(connected);
        }, () => {
          settled++;
          if (settled === urls.length) resolve(0);
        });
      }
    });
  }
  async connectRemaining(startIndex = 3, ms = 5000) {
    await Promise.allSettled(this.relayUrls.slice(startIndex).map((u) => this.connect(u, ms)));
  }
  /**
   * Open up to `count` more relays (best-ranked first) and return the URLs that connected.
   * `prefer` lets the caller name relays that most likely hold the data (e.g. an author's NIP-65
   * write relays); they are tried first and added to the pool. Relays that failed recently are skipped.
   */
  async widen(count = 1, { prefer = [], ms = 3000, preferOnly = false } = {}) {
    const open = (url) => this.connections.get(url)?.ws?.readyState === WebSocket.OPEN;
    const preferred = [...new Set(prefer)].filter((u) => /^wss:\/\//i.test(u));
    for (const url of preferred) if (!this.relayUrls.includes(url)) this.relayUrls.push(url);
    const candidates = [...rankRelays(preferred), ...(preferOnly ? [] : rankRelays(this.relayUrls.filter((u) => !preferred.includes(u))))]
      .filter((url, index, all) => all.indexOf(url) === index && !open(url));
    const connected = [];
    let next = 0;
    while (next < candidates.length && connected.length < count) {
      const wave = candidates.slice(next, next + (count - connected.length));
      next += wave.length;
      const results = await Promise.allSettled(wave.map((url) => this.connect(url, ms)));
      results.forEach((result, index) => { if (result.status === "fulfilled") connected.push(wave[index]); });
    }
    return connected;
  }
  /** Publishing is the one place reach matters more than data: open every healthy configured relay. */
  async connectForPublish(ms = 3000) {
    const urls = this.relayUrls.filter((url) => !isRelayCoolingDown(url) || this.connections.has(url));
    await Promise.allSettled(urls.map((url) => this.connect(url, ms)));
  }
  /** Add and connect to extra relay URLs not already in the pool (e.g. an account's declared write relays). */
  async ensureConnected(urls, ms = 8000) {
    const additions = (urls || []).filter((u) => /^wss:\/\//i.test(u) && !this.relayUrls.includes(u));
    if (!additions.length) return;
    this.relayUrls.push(...additions);
    await Promise.allSettled(additions.map((u) => this.connect(u, ms)));
  }
  connect(url, ms = 8000) {
    const existing = this.connections.get(url);
    if (existing?.ws?.readyState === WebSocket.OPEN) return Promise.resolve(existing.ws);
    this.setStatus(url, { status: "connecting" });
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        recordRelayOutcome(url, false);
        this.setStatus(url, { status: "failed", errors: 1 });
        reject(e);
        return;
      }
      const to = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* noop */ }
        recordRelayOutcome(url, false);
        this.setStatus(url, { status: "failed", errors: 1 });
        reject(new Error("timeout"));
      }, ms);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        recordRelayOutcome(url, true, Date.now() - startedAt);
        this.setStatus(url, { status: "connected", errors: 0 });
        this.connections.set(url, { ws, pendingSubs: new Set() });
        for (const [subId, subscription] of this.subscriptions) {
          if (subscription.targetRelays && !subscription.targetRelays.has(url)) continue;
          ws.send(JSON.stringify(["REQ", subId, ...subscription.filters]));
          subscription.pending.add(url);
        }
        resolve(ws);
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        recordRelayOutcome(url, false);
        this.setStatus(url, { status: "failed", errors: 1 });
        reject(new Error("error"));
      };
      ws.onclose = () => {
        this.connections.delete(url);
        const cur = this.status.get(url);
        if (cur?.status === "connected") this.setStatus(url, { status: "disconnected" });
      };
      ws.onmessage = (m) => this.handleMessage(url, m);
    });
  }
  handleMessage(url, msg) {
    try {
      const d = JSON.parse(msg.data);
      if (d[0] === "EVENT" && d[1] && d[2]) {
        const s = this.status.get(url) || { events: 0 };
        this.setStatus(url, { events: (s.events || 0) + 1 });
        this.subscriptions.get(d[1])?.onEvent?.(d[2], url, d[1]);
        this.onEvent?.(d[2], url, d[1]);
      }
      if (d[0] === "EOSE" && d[1]) {
        this.subscriptions.get(d[1])?.onEOSE?.(d[1], url);
        this.onEOSE?.(d[1], url);
      }
      if (d[0] === "OK" && d[1]) this.onOk?.(d[1], !!d[2], d[3] || "", url);
    } catch { /* ignore malformed frames */ }
  }
  publish(event) {
    const msg = JSON.stringify(["EVENT", event]);
    const targets = [];
    for (const [url, c] of this.connections) {
      if (c.ws?.readyState === WebSocket.OPEN) {
        c.ws.send(msg);
        targets.push(url);
      }
    }
    return targets;
  }
  subscribe(filters, handlers = {}, targetRelays = null) {
    const subId = this.getNextSubId();
    const msg = JSON.stringify(["REQ", subId, ...filters]);
    const pending = new Set();
    for (const [u, c] of this.connections) {
      if (targetRelays && !targetRelays.has(u)) continue;
      if (c.ws?.readyState === WebSocket.OPEN) {
        c.ws.send(msg);
        c.pendingSubs.add(subId);
        pending.add(u);
      }
    }
    this.subscriptions.set(subId, { filters, pending, targetRelays, ...handlers });
    return subId;
  }
  closeSubscription(subId) {
    const subscription = this.subscriptions.get(subId);
    for (const [url, c] of this.connections) {
      if (subscription?.targetRelays && !subscription.targetRelays.has(url)) continue;
      if (c.ws?.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(["CLOSE", subId]));
    }
    this.subscriptions.delete(subId);
  }
  closeAll() {
    for (const s of this.subscriptions.keys()) this.closeSubscription(s);
    for (const [, c] of this.connections) { try { c.ws?.close(); } catch { /* noop */ } }
    this.connections.clear();
  }
}

export function measureRelayLatency(url, timeout = 2500) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let socket;
    let settled = false;
    const finish = (latency) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* noop */ }
      resolve(latency);
    };
    const timer = setTimeout(() => finish(Infinity), timeout);
    try {
      socket = new WebSocket(url);
      socket.onopen = () => finish(Math.round(performance.now() - startedAt));
      socket.onerror = () => finish(Infinity);
      socket.onclose = () => finish(Infinity);
    } catch { finish(Infinity); }
  });
}

/**
 * Run a filter across a RelayManager and collect deduped results until every
 * connected relay sends EOSE (or the timeout elapses, whichever is first).
 */
export function collectEvents(rm, filter, { timeout = 8000, match, relayUrls } = {}) {
  return new Promise((resolve) => {
    const filters = Array.isArray(filter) ? filter : [filter];
    const events = [];
    const seen = new Set();
    const targetRelays = relayUrls ? new Set(relayUrls) : null;
    const expected = new Set([...rm.connections.keys()].filter((url) => !targetRelays || targetRelays.has(url)));
    const arrived = new Set();
    let timer;
    let eoseGraceTimer;
    let done = false;
    let subId;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(eoseGraceTimer);
      rm.closeSubscription(subId);
      resolve(events);
    };

    subId = rm.subscribe(filters, {
      onEvent: (ev) => {
        if (match && !match(ev)) return;
        if (seen.has(ev.id)) return;
        seen.add(ev.id);
        events.push(ev);
      },
      onEOSE: (sid, url) => {
        if (sid !== subId) return;
        if (url) arrived.add(url);
        if (arrived.size >= expected.size) finish();
        else if (!eoseGraceTimer) eoseGraceTimer = setTimeout(finish, Math.min(350, timeout));
      },
    }, targetRelays);
    if (!expected.size) finish();
    else timer = setTimeout(finish, timeout);
  });
}

/**
 * Publish a signed event and wait (up to `timeout`) for NIP-20 OK responses
 * from every relay it was sent to. Returns per-relay results.
 */
export function publishAndConfirm(rm, event, { timeout = 8000 } = {}) {
  return (async () => { await rm.connectForPublish?.(); })().then(() => new Promise((resolve) => {
    const targets = rm.publish(event);
    if (!targets.length) {
      resolve({ accepted: [], rejected: [], pending: [] });
      return;
    }
    const results = new Map();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      rm.onOk = null;
      const accepted = [], rejected = [], pending = [];
      for (const url of targets) {
        const r = results.get(url);
        if (!r) pending.push(url);
        else if (r.ok) accepted.push(url);
        else rejected.push({ url, message: r.message });
      }
      resolve({ accepted, rejected, pending });
    };
    rm.onOk = (id, ok, message, url) => {
      if (id !== event.id) return;
      results.set(url, { ok, message });
      if (results.size >= targets.length) finish();
    };
    setTimeout(finish, timeout);
  }));
}
