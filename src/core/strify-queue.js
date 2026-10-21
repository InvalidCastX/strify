// Pure play-order logic for the global player (no audio, no DOM) so it can be unit-tested.
export function buildOrder(length, currentIndex, shuffle, rng = Math.random) {
  const order = Array.from({ length }, (_, i) => i);
  if (!shuffle || length < 2) return order;
  const rest = order.filter((i) => i !== currentIndex);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return currentIndex >= 0 && currentIndex < length ? [currentIndex, ...rest] : rest;
}

/**
 * Where to go next. `auto` = the track ended on its own.
 * Returns { pos, wrapped, stop }. `stop` means playback should end (queue finished, repeat off).
 */
export function stepNext({ pos, length, repeat, auto }) {
  if (!length) return { pos: -1, stop: true };
  if (auto && repeat === "one") return { pos, restart: true };
  if (pos + 1 < length) return { pos: pos + 1 };
  if (repeat === "all") return { pos: 0, wrapped: true };
  return auto ? { pos, stop: true } : { pos, stop: true, atEnd: true };
}

export function stepPrev({ pos, length, repeat, currentTime }) {
  if (!length) return { pos: -1 };
  if (currentTime > 3) return { pos, restart: true };
  if (pos > 0) return { pos: pos - 1 };
  if (repeat === "all") return { pos: length - 1 };
  return { pos, restart: true };
}

export const REPEAT_CYCLE = ["off", "all", "one"];
export const nextRepeat = (mode) => REPEAT_CYCLE[(REPEAT_CYCLE.indexOf(mode) + 1) % REPEAT_CYCLE.length];
