// One persistent audio engine + store for strify. Lives at module level, never inside route markup,
// so internal navigation (which only swaps #mainContent) never restarts or duplicates playback.
import { buildOrder, stepNext, stepPrev, nextRepeat } from "./strify-queue.js";

const VOLUME_KEY = "strify:volume";
const audio = typeof Audio !== "undefined" ? new Audio() : null;
if (audio) audio.preload = "metadata";

const store = {
  queue: [], order: [], pos: -1,
  playing: false, buffering: false, error: "", needsGesture: false,
  currentTime: 0, duration: 0, volume: 0.9, muted: false,
  shuffle: false, repeat: "off", label: "",
};
const listeners = new Set();
const timeListeners = new Set();
let consecutiveFailures = 0;
let guard = null; // optional () => void called just before playback starts (pauses other audio)

try { const v = Number(localStorage.getItem(VOLUME_KEY)); if (Number.isFinite(v) && v >= 0 && v <= 1 && localStorage.getItem(VOLUME_KEY) !== null) store.volume = v; } catch { /* default volume */ }
if (audio) audio.volume = store.volume;

const emit = () => listeners.forEach((fn) => { try { fn(store); } catch (e) { console.error(e); } });
const emitTime = () => timeListeners.forEach((fn) => { try { fn(store); } catch (e) { console.error(e); } });

export const getState = () => store;
export const currentTrack = () => (store.pos >= 0 ? store.queue[store.order[store.pos]] || null : null);
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function subscribeTime(fn) { timeListeners.add(fn); return () => timeListeners.delete(fn); }
export function setPlayGuard(fn) { guard = fn; }
export function upcoming() { return store.order.map((qi, p) => ({ track: store.queue[qi], pos: p })); }

function updateMediaSession() {
  try {
    if (!("mediaSession" in navigator)) return;
    const track = currentTrack();
    if (!track) { navigator.mediaSession.metadata = null; return; }
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist || "strify", album: track.album || "strify", artwork: track.coverArt ? [{ src: track.coverArt }] : [] });
    navigator.mediaSession.setActionHandler("play", () => toggle(true));
    navigator.mediaSession.setActionHandler("pause", () => toggle(false));
    navigator.mediaSession.setActionHandler("nexttrack", () => next());
    navigator.mediaSession.setActionHandler("previoustrack", () => prev());
    navigator.mediaSession.setActionHandler("seekto", (d) => { if (Number.isFinite(d?.seekTime)) seek(d.seekTime); });
  } catch { /* media session is optional */ }
}

async function startPlayback() {
  if (!audio) return;
  guard?.();
  store.needsGesture = false;
  try { await audio.play(); }
  catch (error) {
    if (error?.name === "NotAllowedError") { store.needsGesture = true; store.playing = false; store.error = "Your browser blocked autoplay. Press play to start."; }
    else if (error?.name !== "AbortError") { store.error = "This track can't be played."; }
    emit();
  }
}

function loadCurrent({ autoplay = true } = {}) {
  const track = currentTrack();
  if (!audio || !track) return;
  store.error = ""; store.currentTime = 0; store.duration = track.duration || 0; store.buffering = true;
  audio.src = track.url;
  updateMediaSession();
  emit(); emitTime();
  if (autoplay) void startPlayback();
}

/** Replace the queue and start at `index`. Playing someone's playlist or a grid only builds this local queue. */
export function playQueue(tracks, index = 0, { label = "" } = {}) {
  const list = (tracks || []).filter((t) => t?.url);
  if (!list.length) return;
  const start = Math.min(Math.max(0, index), list.length - 1);
  // Same track in same queue position: just resume instead of restarting.
  const cur = currentTrack();
  if (cur && cur.key === list[start].key && store.queue.length === list.length && audio?.src) { toggle(true); return; }
  store.queue = list;
  store.order = buildOrder(list.length, start, store.shuffle);
  store.pos = store.order.indexOf(start);
  store.label = label;
  consecutiveFailures = 0;
  loadCurrent();
}

export function toggle(force) {
  if (!audio || !currentTrack()) return;
  const wantPlay = typeof force === "boolean" ? force : audio.paused;
  if (wantPlay) { store.error = store.needsGesture ? "" : store.error; void startPlayback(); } else audio.pause();
}

function goTo(pos, autoplay = true) {
  store.pos = pos;
  loadCurrent({ autoplay });
}

export function next(auto = false) {
  const step = stepNext({ pos: store.pos, length: store.order.length, repeat: store.repeat, auto });
  if (step.restart) { seek(0); void startPlayback(); return; }
  if (step.stop) { if (auto) { audio?.pause(); store.playing = false; seekQuiet(0); emit(); } return; }
  if (step.wrapped && store.shuffle) { store.order = buildOrder(store.queue.length, -1, true); }
  goTo(step.pos);
}

export function prev() {
  const step = stepPrev({ pos: store.pos, length: store.order.length, repeat: store.repeat, currentTime: audio?.currentTime || 0 });
  if (step.restart) { seek(0); return; }
  goTo(step.pos);
}

export function playAt(pos) { if (pos >= 0 && pos < store.order.length) goTo(pos); }

function seekQuiet(t) { if (audio) { try { audio.currentTime = t; } catch { /* not seekable yet */ } store.currentTime = t; emitTime(); } }
export function seek(seconds) {
  if (!audio || !Number.isFinite(seconds)) return;
  const max = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : store.duration || 0;
  seekQuiet(Math.min(Math.max(0, seconds), max || seconds));
}

export function setVolume(value) {
  const v = Math.min(1, Math.max(0, Number(value)));
  if (!audio || !Number.isFinite(v)) return;
  store.volume = v; audio.volume = v;
  if (v > 0 && store.muted) { store.muted = false; audio.muted = false; }
  try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* cache only */ }
  emit();
}
export function toggleMute() { if (!audio) return; store.muted = !store.muted; audio.muted = store.muted; emit(); }

export function toggleShuffle() {
  store.shuffle = !store.shuffle;
  const currentQueueIndex = store.order[store.pos] ?? -1;
  store.order = buildOrder(store.queue.length, currentQueueIndex, store.shuffle);
  store.pos = currentQueueIndex >= 0 ? store.order.indexOf(currentQueueIndex) : -1;
  emit();
}
export function cycleRepeat() { store.repeat = nextRepeat(store.repeat); emit(); }

export function stop() {
  if (!audio) return;
  audio.pause(); audio.removeAttribute("src"); audio.load();
  Object.assign(store, { queue: [], order: [], pos: -1, playing: false, buffering: false, error: "", currentTime: 0, duration: 0, label: "" });
  updateMediaSession(); emit(); emitTime();
}
export const pauseStrify = () => { if (audio && !audio.paused) audio.pause(); };
export const isStrifyPlaying = () => !!audio && !audio.paused && !audio.ended;

if (audio) {
  let lastTick = 0;
  audio.addEventListener("play", () => { store.playing = true; store.needsGesture = false; emit(); });
  audio.addEventListener("pause", () => { store.playing = false; emit(); });
  audio.addEventListener("playing", () => { store.buffering = false; store.error = ""; consecutiveFailures = 0; emit(); });
  audio.addEventListener("waiting", () => { store.buffering = true; emit(); });
  audio.addEventListener("canplay", () => { store.buffering = false; emit(); });
  audio.addEventListener("loadedmetadata", () => { if (Number.isFinite(audio.duration)) { store.duration = audio.duration; emit(); emitTime(); } });
  audio.addEventListener("durationchange", () => { if (Number.isFinite(audio.duration) && audio.duration > 0) { store.duration = audio.duration; emitTime(); } });
  audio.addEventListener("timeupdate", () => {
    const now = performance.now();
    if (now - lastTick < 250) return; // progress UI refreshes ~4x/second at most
    lastTick = now; store.currentTime = audio.currentTime; emitTime();
  });
  audio.addEventListener("ended", () => next(true));
  audio.addEventListener("error", () => {
    if (!audio.getAttribute("src")) return;
    store.buffering = false; store.playing = false;
    store.error = "This track's audio is unavailable.";
    consecutiveFailures++;
    emit();
    // Skip forward past dead media, but stop after a full queue of failures so we never loop forever.
    if (consecutiveFailures < Math.min(store.queue.length, 5) && store.pos + 1 < store.order.length) setTimeout(() => next(true), 900);
  });
}
