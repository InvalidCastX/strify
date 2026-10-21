// Lightning zaps (NIP-57) for a track. Pays through WebLN when a wallet extension is present,
// otherwise shows the invoice to copy or open in any Lightning wallet.
import { decodeLnurl } from "./nostr-core.js";
import { signEvent } from "./auth.js";
import { writeRelays } from "./relays.js";
import { escapeHtml as E, copyToClipboard } from "./format.js";

const PRESETS = [21, 100, 500, 1000, 5000];

function lnurlEndpoint(profile) {
  const address = String(profile?.lud16 || "").trim();
  const match = address.match(/^([a-z0-9._+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i);
  if (match) return `https://${match[2]}/.well-known/lnurlp/${encodeURIComponent(match[1])}`;
  const lud06 = String(profile?.lud06 || "").trim();
  return lud06 ? decodeLnurl(lud06) : null;
}

async function requestInvoice({ profile, noteId, pubkey, sats, comment, session }) {
  const endpoint = lnurlEndpoint(profile);
  if (!endpoint) throw new Error("This artist hasn't set a Lightning address.");
  const meta = await (await fetch(endpoint)).json();
  if (!meta?.callback) throw new Error("The artist's Lightning provider didn't respond correctly.");
  const msats = sats * 1000;
  if (msats < Number(meta.minSendable || 0)) throw new Error(`Minimum is ${Math.ceil(meta.minSendable / 1000)} sats.`);
  if (msats > Number(meta.maxSendable || Infinity)) throw new Error(`Maximum is ${Math.floor(meta.maxSendable / 1000)} sats.`);
  const url = new URL(meta.callback);
  url.searchParams.set("amount", String(msats));
  if (comment && Number(meta.commentAllowed) > 0) url.searchParams.set("comment", comment.slice(0, Number(meta.commentAllowed)));
  if (meta.allowsNostr && meta.nostrPubkey && session) {
    const request = await signEvent({
      kind: 9734, content: comment || "",
      tags: [["relays", ...writeRelays().slice(0, 5)], ["amount", String(msats)], ["p", pubkey], ["e", noteId]],
    }, session);
    url.searchParams.set("nostr", JSON.stringify(request));
  }
  const data = await (await fetch(url)).json();
  if (data?.status === "ERROR" || !data?.pr) throw new Error(data?.reason || "No invoice was returned.");
  return data.pr;
}

export function openZapModal({ noteId, pubkey, profile, session, toast }) {
  if (!lnurlEndpoint(profile)) { toast("This artist hasn't set a Lightning address, so they can't be zapped yet."); return; }
  document.getElementById("sxZap")?.remove();
  const name = profile?.display_name || profile?.name || "this artist";
  const el = document.createElement("div");
  el.id = "sxZap"; el.className = "sx-backdrop";
  el.innerHTML = `<div class="sx-modal" role="dialog" aria-modal="true" aria-label="Zap ${E(name)}">
    <div class="sx-modal-head"><h2>Zap ${E(name)}</h2><button type="button" class="sx-icon-btn" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
    <form data-zap-form>
      <div class="sx-presets">${PRESETS.map((n) => `<button type="button" class="sx-chip" data-preset="${n}">${n}</button>`).join("")}</div>
      <label class="sx-field"><span>Amount (sats)</span><input name="sats" inputmode="numeric" autocomplete="off" placeholder="21"></label>
      <label class="sx-field"><span>Comment (optional)</span><input name="comment" maxlength="140" autocomplete="off"></label>
      <p class="sx-status" data-status role="status"></p>
      <div data-invoice hidden></div>
      <div class="sx-actions-row"><button type="button" class="sx-btn" data-close>Cancel</button><button type="submit" class="sx-btn sx-primary" data-submit><i class="fa-solid fa-bolt"></i> Zap</button></div>
    </form></div>`;
  document.body.appendChild(el);
  const form = el.querySelector("[data-zap-form]");
  const status = el.querySelector("[data-status]");
  const submit = el.querySelector("[data-submit]");
  const close = () => el.remove();
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest("[data-close]")) { close(); return; }
    const preset = e.target.closest("[data-preset]");
    if (preset) form.elements.sats.value = preset.dataset.preset;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const sats = Number(form.elements.sats.value);
    if (!Number.isInteger(sats) || sats < 1) { status.textContent = "Enter a whole number of sats."; return; }
    submit.disabled = true; status.textContent = "Requesting invoice…";
    try {
      const pr = await requestInvoice({ profile, noteId, pubkey, sats, comment: form.elements.comment.value.trim(), session });
      if (window.webln) {
        try { await window.webln.enable(); await window.webln.sendPayment(pr); toast(`Zapped ${sats} sats.`); close(); return; }
        catch { /* the wallet declined: show the invoice instead */ }
      }
      status.textContent = "Pay this invoice with any Lightning wallet.";
      const box = el.querySelector("[data-invoice]");
      box.hidden = false;
      box.innerHTML = `<textarea class="sx-invoice" readonly rows="3">${E(pr)}</textarea><div class="sx-actions-row"><button type="button" class="sx-btn" data-copy>Copy invoice</button><a class="sx-btn sx-primary" href="lightning:${E(pr)}">Open wallet</a></div>`;
      box.querySelector("[data-copy]").addEventListener("click", () => copyToClipboard(pr, (ok) => toast(ok ? "Invoice copied." : "Couldn't copy the invoice.")));
      submit.hidden = true;
    } catch (error) {
      status.textContent = error?.message || "The zap couldn't be started.";
      submit.disabled = false;
    }
  });
  form.elements.sats.focus();
}
