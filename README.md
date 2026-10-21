# strify

A standalone Nostr music app, extracted from friendstr. Explore and play music from Nostr relays with no account, or log in to upload tracks, like, comment, zap, repost and build playlists.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
npm test
```

The build is a static site. `vercel.json` (Vercel) and `public/_redirects` (Cloudflare Pages / Netlify) send every path to `index.html`.

## Login (optional)

- **Nostr extension (NIP-07):** Alby, nos2x, etc. Keys never leave the extension.
- **nsec:** signs locally in the browser. Stored only if "Keep me logged in" is ticked.
- **No login:** browse, search and play everything.

## Relays

Open **Relays** in the top bar. Each relay has **Read** and **Write** switches: strify searches read relays and publishes to write relays.

- Default relay: `wss://relay.bchnostr.com`, followed by 20 more (damus, primal, nos.lol, nostr.band, snort, …). Edit `DEFAULT_RELAYS` in `src/core/relays.js`.
- Add any `wss://` relay, remove relays, test latency, reset to defaults, and (when logged in) import your own NIP-65 relay list.
- Settings persist in `localStorage` (`strify:relays:v1`). Closing the dialog after a change reloads the music from the new relay set.

## What changed from friendstr

Kept as-is: `src/ui/Strify.js` and all `src/core/strify-*.js` (player, tracks, playlists, upload, artist pages, quality filter, status sharing).

Replaced or added: `src/main.js` (shell, login and relay dialogs, host API), `core/relays.js`, `core/publish.js` (publishes to write relays only), `core/zap.js` (Lightning zaps), `core/auth.js` (nostr-tools bundled instead of loaded from a CDN), `core/router.js`, and slim `format.js`, `music.js`, `profile-player.js`.

Removed: friendstr's feed, profiles, DMs, notifications, themes, premium payments, Cloudflare functions and the D1 database.

- Premium limits apply to everyone (10 playlists, 20 tracks each). To restore a free tier, change `isPremium` in `src/main.js`.
- Zaps are Lightning only (NIP-57 via WebLN or a copyable invoice). friendstr's BCH zap option was not carried over.
- The artist page links to njump.me instead of a friendstr profile.
- Uploads use Blossom servers from `UPLOAD` in `src/core/strify-config.js`, with nostr.build as fallback.
