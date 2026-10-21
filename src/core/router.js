// Standalone strify has one page ("/"); an artist discography is "/?artist=<npub>".
export function resolveRoute(pathname = window.location.pathname) {
  const path = String(pathname || "/");
  return path === "/" || path === "" || path === "/strify" || path === "/strify/" ? { page: "strify" } : { page: "not-found" };
}

export function navigate(path, { replace = false, state = {} } = {}) {
  const target = new URL(path, window.location.origin);
  if (target.origin !== window.location.origin) throw new TypeError("Client-side navigation must stay on this origin.");
  const url = `${target.pathname}${target.search}${target.hash}`;
  if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history[replace ? "replaceState" : "pushState"](state, "", url);
  window.dispatchEvent(new PopStateEvent("popstate", { state }));
}
