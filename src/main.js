import "./strify.css";
import "./shell.css";
import { escapeHtml as E, shorten } from "./core/format.js";
import { loadSession, saveSession, clearSession, nsecSignIn, nip07SignIn, signEvent } from "./core/auth.js";
import { npubFromHex, measureRelayLatency } from "./core/nostr-core.js";
import { StrifyNet } from "./core/strify-net.js";
import { safeHttpsUrl } from "./core/strify-tracks.js";
import { DEFAULT_RELAY_URL, getRelays, readRelays, setRelays, addRelay, removeRelay, updateRelay, resetRelays, mergeRelayListEvent } from "./core/relays.js";
import { publishEvent } from "./core/publish.js";
import { uploadNostrBuildFile } from "./core/upload.js";
import { openZapModal } from "./core/zap.js";
import { initStrify, renderStrifyPage, startStrifyPage } from "./ui/Strify.js";

const state = { session: loadSession(), profile: null };
const shellNet = new StrifyNet(); // profile and relay-list lookups for the shell itself
const icon = (name) => `<i class="fa-solid ${name}" aria-hidden="true"></i>`;

// ── Layout ─────────────────────────────────────────────────────────
document.getElementById("root").innerHTML = `<div class="sx-shell">
  <div class="sx-bar" role="toolbar" aria-label="App">
    <button type="button" class="sx-btn" data-sx-relays aria-label="Relay settings">${icon("fa-server")} Relays <span class="sx-badge" data-sx-relay-count></span></button>
    <div data-sx-account></div>
  </div>
  <main id="mainContent"></main>
  <footer class="sx-foot">strify reads and publishes music over Nostr relays you choose.</footer>
</div>
<div class="fs-toast-host" id="sxToasts" aria-live="polite"></div>`;

function toast(message) {
  const el = document.createElement("div");
  el.className = "sx-toast"; el.textContent = String(message || "");
  document.getElementById("sxToasts").appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function paintRelayCount() {
  const count = document.querySelector("[data-sx-relay-count]");
  if (count) count.textContent = String(readRelays().length);
}

// ── Account chip ───────────────────────────────────────────────────
function paintAccount() {
  const host = document.querySelector("[data-sx-account]");
  if (!state.session) { host.innerHTML = `<button type="button" class="sx-btn sx-primary" data-sx-login>${icon("fa-key")} Log in</button>`; return; }
  const pk = state.session.pubkeyHex;
  const name = state.profile?.display_name || state.profile?.name || shorten(npubFromHex(pk), 8, 4);
  const pic = safeHttpsUrl(state.profile?.picture);
  host.innerHTML = `<div class="sx-account"><span class="sx-avatar">${pic ? `<img class="sx-avatar" src="${E(pic)}" alt="" referrerpolicy="no-referrer">` : icon("fa-user")}</span><span class="sx-account-name">${E(name)}</span><button type="button" class="sx-btn" data-sx-logout>Log out</button></div>`;
}

async function loadMyProfile() {
  const pk = state.session?.pubkeyHex;
  if (!pk) return;
  try {
    const events = await shellNet.fetch([{ kinds: [0], authors: [pk], limit: 1 }], { urls: readRelays().slice(0, 6), timeout: 4000 });
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (newest && state.session?.pubkeyHex === pk) { state.profile = JSON.parse(newest.content || "{}"); paintAccount(); }
  } catch { /* the chip keeps showing the short npub */ }
}

function setSession(signer, { remember } = {}) {
  state.session = signer; state.profile = null;
  saveSession(signer, { remember });
  paintAccount(); void loadMyProfile();
  window.dispatchEvent(new Event("strify:session"));
}
function logout() {
  clearSession(); state.session = null; state.profile = null;
  paintAccount(); toast("Logged out.");
  window.dispatchEvent(new Event("strify:session"));
}

// ── Dialogs ────────────────────────────────────────────────────────
function openDialog(id, html, label) {
  document.getElementById(id)?.remove();
  const el = document.createElement("div");
  el.id = id; el.className = "sx-backdrop";
  el.innerHTML = `<div class="sx-modal" role="dialog" aria-modal="true" aria-label="${E(label)}">${html}</div>`;
  const restore = document.activeElement;
  document.body.appendChild(el);
  const close = () => { el.remove(); restore?.focus?.(); el._onClose?.(); };
  el.addEventListener("click", (e) => { if (e.target === el || e.target.closest("[data-close]")) close(); });
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  return { el, close };
}

function openAuthModal(message = "") {
  const hasExtension = !!window.nostr?.getPublicKey;
  const { el, close } = openDialog("sxAuth", `
    <div class="sx-modal-head"><h2>Log in to strify</h2><button type="button" class="sx-icon-btn" data-close aria-label="Close">${icon("fa-xmark")}</button></div>
    <p class="sx-note">${E(message || "Log in with your Nostr account to upload music, like, comment and build playlists. You can explore music without logging in.")}</p>
    <button type="button" class="sx-btn sx-primary sx-method" data-ext ${hasExtension ? "" : "disabled"}>${icon("fa-puzzle-piece")} Log in with a Nostr extension</button>
    <p class="sx-note">${hasExtension ? "Your keys stay in the extension (NIP-07)." : "No extension found. Install one like Alby or nos2x to use this option."}</p>
    <hr class="sx-divider">
    <form data-nsec-form>
      <label class="sx-field"><span>Or paste your private key (nsec)</span><input name="nsec" type="password" autocomplete="off" spellcheck="false" placeholder="nsec1…"></label>
      <label class="sx-check"><input type="checkbox" name="remember"> Keep me logged in on this device</label>
      <p class="sx-note is-warn">Only paste your nsec on a device you trust. It's used in this browser to sign and is never sent anywhere.</p>
      <p class="sx-status" data-status role="status"></p>
      <div class="sx-actions-row"><button type="button" class="sx-btn" data-close>Keep exploring</button><button type="submit" class="sx-btn sx-primary">Log in</button></div>
    </form>`, "Log in");
  const status = el.querySelector("[data-status]");
  const fail = (text) => { status.textContent = text; status.classList.add("is-error"); };
  el.querySelector("[data-ext]").addEventListener("click", async () => {
    status.classList.remove("is-error"); status.textContent = "Waiting for your extension…";
    const { signer, error } = await nip07SignIn();
    if (error) { fail(error); return; }
    setSession(signer, { remember: true }); close(); toast("Logged in.");
  });
  el.querySelector("[data-nsec-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    status.classList.remove("is-error");
    const { signer, error } = await nsecSignIn(form.elements.nsec.value);
    if (error) { fail(error); return; }
    form.elements.nsec.value = "";
    setSession(signer, { remember: form.elements.remember.checked }); close(); toast("Logged in.");
  });
  (hasExtension ? el.querySelector("[data-ext]") : el.querySelector("[name=nsec]")).focus();
}

function openRelayModal() {
  let dirty = false;
  const health = new Map(); // url -> "testing" | ms | Infinity
  const { el, close } = openDialog("sxRelays", `
    <div class="sx-modal-head"><h2>Relays</h2><button type="button" class="sx-icon-btn" data-close aria-label="Close">${icon("fa-xmark")}</button></div>
    <p class="sx-note">strify searches the relays you read from and publishes to the ones you write to. Adding more relays finds more music.</p>
    <form class="sx-add" data-add-form><input name="url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="wss://relay.example.com" aria-label="Relay address"><button type="submit" class="sx-btn sx-primary">Add</button></form>
    <p class="sx-status" data-status role="status"></p>
    <div class="sx-relay-tools">
      <button type="button" class="sx-btn" data-test-all>${icon("fa-gauge-high")} Test all</button>
      <button type="button" class="sx-btn" data-import ${state.session ? "" : "disabled"} title="${state.session ? "Add the relays from your Nostr relay list" : "Log in to import your relay list"}">${icon("fa-download")} Import my relays</button>
      <button type="button" class="sx-btn sx-danger" data-reset>${icon("fa-rotate-left")} Reset to defaults</button>
    </div>
    <ul class="sx-relay-list" data-list></ul>
    <div class="sx-actions-row"><button type="button" class="sx-btn sx-primary" data-close>Done</button></div>`, "Relay settings");
  const list = el.querySelector("[data-list]");
  const status = el.querySelector("[data-status]");
  const say = (text, isError = false) => { status.textContent = text; status.classList.toggle("is-error", isError); };
  const changed = () => { dirty = true; paintRelayCount(); paint(); };

  function paint() {
    list.innerHTML = getRelays().map((r) => {
      const h = health.get(r.url);
      const cls = h === "testing" ? "is-testing" : h === undefined ? "" : Number.isFinite(h) ? "is-ok" : "is-bad";
      const meta = h === "testing" ? "Testing…" : h === undefined ? (r.url === DEFAULT_RELAY_URL ? "Default" : "") : Number.isFinite(h) ? `${h} ms${r.url === DEFAULT_RELAY_URL ? " · Default" : ""}` : "Unreachable";
      return `<li class="sx-relay" data-url="${E(r.url)}"><span class="sx-dot ${cls}" aria-hidden="true"></span>
        <span class="sx-relay-main"><span class="sx-relay-url" title="${E(r.url)}">${E(r.url.replace(/^wss:\/\//, ""))}</span><span class="sx-relay-meta">${E(meta)}</span></span>
        <label class="sx-toggle"><input type="checkbox" data-flag="read" ${r.read ? "checked" : ""}> Read</label>
        <label class="sx-toggle"><input type="checkbox" data-flag="write" ${r.write ? "checked" : ""}> Write</label>
        <button type="button" class="sx-icon-btn" data-remove aria-label="Remove ${E(r.url)}">${icon("fa-trash")}</button></li>`;
    }).join("");
  }
  async function test(urls) {
    urls.forEach((u) => health.set(u, "testing")); paint();
    await Promise.all(urls.map(async (u) => { health.set(u, await measureRelayLatency(u)); if (el.isConnected) paint(); }));
  }

  el._onClose = () => { if (dirty) window.dispatchEvent(new Event("strify:relays")); };
  el.querySelector("[data-add-form]").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = e.currentTarget.elements.url;
    const result = addRelay(input.value);
    if (result.error) { say(result.error, true); return; }
    const url = result.relays[result.relays.length - 1].url;
    input.value = ""; say(`Added ${url.replace(/^wss:\/\//, "")}.`); changed(); void test([url]);
  });
  el.addEventListener("change", (e) => {
    const box = e.target.closest("[data-flag]"); if (!box) return;
    const url = box.closest("[data-url]").dataset.url;
    const result = updateRelay(url, { [box.dataset.flag]: box.checked });
    if (result.error) { say(result.error, true); box.checked = true; return; }
    say(""); changed();
  });
  el.addEventListener("click", async (e) => {
    const row = e.target.closest("[data-url]");
    if (e.target.closest("[data-remove]") && row) {
      const result = removeRelay(row.dataset.url);
      if (result.error) say(result.error, true); else { say(""); changed(); }
    } else if (e.target.closest("[data-test-all]")) { say("Testing relays…"); await test(getRelays().map((r) => r.url)); say("Done testing."); }
    else if (e.target.closest("[data-reset]")) { resetRelays(); health.clear(); say("Back to the default relays."); changed(); }
    else if (e.target.closest("[data-import]")) {
      say("Looking up your relay list…");
      try {
        const events = await shellNet.fetch([{ kinds: [10002], authors: [state.session.pubkeyHex], limit: 3 }], { urls: readRelays().slice(0, 6), timeout: 4500 });
        const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
        if (!newest) { say("No relay list found for your account on these relays.", true); return; }
        const added = mergeRelayListEvent(newest);
        say(added ? `Added ${added} relay${added === 1 ? "" : "s"} from your list.` : "Your relay list is already included."); if (added) changed();
      } catch (error) { say(error?.message || "Couldn't reach a relay to look up your list.", true); }
    }
  });
  paint();
  el.querySelector("[name=url]").focus();
}

// ── Page events ────────────────────────────────────────────────────
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-sx-login]")) openAuthModal();
  else if (e.target.closest("[data-sx-logout]")) logout();
  else if (e.target.closest("[data-sx-relays]")) openRelayModal();
});

// ── strify host: what the music module needs from the app ──────────
initStrify({
  getSession: () => state.session,
  getUserRelays: () => readRelays(),
  getFollows: () => [],
  isPremium: () => true, // no paid tier in the standalone app: everyone gets the larger playlist limits
  isPremiumLoading: () => false,
  sign: (template) => signEvent(template, state.session),
  uploadFallback: async (file) => (await uploadNostrBuildFile(file, state.session)).href,
  toast,
  signIn: (message) => openAuthModal(message),
  async publish(template) {
    if (state.session?.type === "nip07" && !window.nostr?.signEvent) throw new Error("Your Nostr extension isn't available. Reload the page or log in again.");
    return publishEvent(template, state.session);
  },
  async openZap(noteId, pubkey, profile) {
    let p = profile;
    if (!p?.lud16 && !p?.lud06) {
      try {
        const events = await shellNet.fetch([{ kinds: [0], authors: [pubkey], limit: 1 }], { urls: readRelays().slice(0, 6), timeout: 4000 });
        const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
        if (newest) p = { ...profile, ...JSON.parse(newest.content || "{}") };
      } catch { /* openZapModal explains when there is no Lightning address */ }
    }
    openZapModal({ noteId, pubkey, profile: p, session: state.session, toast });
  },
});

function render() {
  document.getElementById("mainContent").innerHTML = renderStrifyPage();
  startStrifyPage();
}
window.addEventListener("popstate", render);

paintAccount(); paintRelayCount(); render();
if (state.session) void loadMyProfile();
