# yt-subscriptions++

Your YouTube subscription feed, on your rules. No algorithm, no Shorts, and sorting that goes
beyond "newest".

It is a static single-page app: your browser talks to the YouTube Data API directly. There is no
backend, no database, and no third party in the middle. Your subscriptions and the feed cache
never leave your machine.

## What it does

**One flat feed, your rules.** Every upload from every subscription lands in a single grid — no
recommendations, no reordering by engagement, no Shorts (they are never fetched, so there is
nothing to hide). What you *do* get to control:

- **Sort** by publish date (newest or oldest first), absolute view count, or **trending** —
  views per hour since publication, which surfaces what is taking off right now rather than what
  is merely old and popular.
- **Shuffle** re-deals the page on screen into a random order. It is a button, not a sort:
  leaving the page or touching any rule un-shuffles.
- **Filter** by an inclusive release-date window (with presets, in your timezone), by substring
  search over titles and channel names, by your channel tags, or by muting channels outright — a
  muted channel vanishes from the feed but stays in the channels view, where the mute is undone.

Every rule persists in `localStorage`; the feed opens exactly the way you left it.

**Channel tags.** Label subscriptions with colored tags and filter the feed by them — pick any
number, with a Match switch choosing between *any* (OR) and *all* (AND) when several are
selected. Up to 10 tags per channel, each wearing one of 32 palette colors (chip text flips
between dark and light by the color's measured luminance). Videos inherit their channel's tags,
and the filter stays flat-cost at feed scale: selected tags collapse to one set of admitted
channels, a single lookup per video even at 200k videos.

Tags are created, renamed, recolored and deleted in the channels view — where they are assigned —
and live in IndexedDB per account, surviving refreshes and cache clears. The manage panel exports
them all to a JSON file and imports one back, which is how tags move to another browser or
account. Import merges by name (case-insensitively) and is strictly additive: existing tags gain
the file's channel assignments but keep their local color and casing, unknown names become new
tags, nothing local is ever removed, and importing the same file twice is a no-op.

**Channels view.** One row per subscription — its newest uploads, indexed count, and
latest-upload age — searchable, sortable by recency or name, and the place where tags are
assigned and channels muted.

**Refresh, on your terms.** Opening the page paints the cached feed instantly and, if your
session is still valid, starts a refresh on its own — reloading the tab *is* the "check for new
videos" gesture. Indexing runs in a Web Worker off the main thread, streams into the cache batch
by batch, and is cancelable mid-run by pressing the button again: everything already indexed
stays. The header counts the YouTube API quota units spent since the last reset, so you always
know where the day's budget stands.

**Built for scale.** The grid is virtualized (only rows near the viewport are mounted) and the
feed paginates, so a six-figure video cache scrolls smoothly on a phone. On narrow viewports the
controls block slides away while scrolling down and returns on the first scroll up, counters drop
to their own row, and rare actions (Clear cache, Sign out) tuck into a ☰ menu.

## Setup

The site runs on GitHub Pages: fork this repository and every push to `main` deploys it through
the bundled workflow (`.github/workflows/pages.yml`) to `https://<user>.github.io/<repo>/`.
Hosting the page publicly shares the code, not your data — the feed cache stays in each
visitor's own browser.

You also need your own Google OAuth client ID. It is free, takes about five minutes, and is
required because the app has no server to hold credentials for you.

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/projectcreate).
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. Open [**Google Auth Platform**](https://console.cloud.google.com/auth/overview) and click
   **Get started**. Give the app a name and a support email, set **Audience** to **External**, add
   a contact email, and finish the wizard.
4. **Google Auth Platform → Data Access** → **Add or remove scopes** → add
   `https://www.googleapis.com/auth/youtube.readonly` → **Update**, then **Save**.
5. **Google Auth Platform → Audience** → under **Test users**, **Add users** → your own Google
   account. Leave the publishing status on **Testing**: no Google verification is required, and up
   to 100 test users are allowed. Test authorizations expire after 7 days, so expect to pass
   through the consent screen again about once a week.
6. **Google Auth Platform → Clients** → **Create client** → **Web application**. Under
   **Authorized JavaScript origins** add `https://<user>.github.io` — origins carry no path, so
   the bare `github.io` host of your account is the whole entry. (For local development, also add
   `http://localhost:5173` and `http://localhost`; Google asks for the bare host as well as the
   port-specific origin.) Leave **Authorized redirect URIs** empty; the Google Identity Services
   token flow does not use them.
7. Copy the client ID.

Then publish the site:

1. Fork this repository.
2. In the fork, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main` (or run the **Deploy to GitHub Pages** workflow manually). The URL appears on
   the workflow run and under **Settings → Pages**.
4. Open the page, allow popups for it (sign-in uses one), and paste your client ID into the
   setup screen. The ID lives in your browser's `localStorage`, not in the repo — a client ID is
   public by design, though anyone who copies yours shares your daily quota.

Only Google accounts on your **Test users** list can sign in (see the note below).

### Running locally

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173 and paste the client ID into the setup screen. (Alternatively, put it in
a `.env` file as `VITE_GOOGLE_CLIENT_ID=…` — see `.env.example`.)

Click **Sign in with Google**. Sign-in uses a popup, so allow popups for `localhost:5173`.

## API quota

Google gives each project 10,000 quota units per day, resetting at midnight Pacific.

Scanning costs `2N` to `3N` units for `N` subscribed channels: one `playlistItems` call for the
long-form list, a second if the channel has more than 50 uploads, and one for the live list, which
for most channels 404s immediately. At 300 subscriptions that is roughly 600–900 units, so about
11–16 scans a day before video details are counted.

On top of that, `subscriptions.list` costs `ceil(N/50)`, the account lookup costs 1, and
`videos.list` costs 1 unit per 50 videos actually fetched — which on a first index of 300 channels
can be another ~600. Later refreshes are far cheaper, since only genuinely new videos and rows
whose details have aged out need fetching.

The app keeps the total down by:

- deriving playlist IDs from the channel ID instead of spending a `channels.list` call per
  channel;
- reading only video IDs while scanning channels, then fetching details only for videos it has
  not already cached;
- never reading the Shorts playlist at all;
- caching video metadata in IndexedDB and re-reading a row only once its details are stale.

## Commands

```bash
npm run dev
```

```bash
npm run build
```

```bash
npm run typecheck
```

## Layout

```
src/
  lib/
    auth.ts           Google Identity Services token flow (no client secret)
    youtube.ts        YouTube Data API v3 client, quota-conscious feed assembly
    feed.worker.ts    The refresh itself, off the main thread; writes to IndexedDB
    feed-protocol.ts  Messages between App and the worker
    feed-mock.ts      Offline fixtures / API mocks for development and benchmarks
    rules.ts          Sorting and filtering — the actual "my own rules" logic
    store.ts          Rule persistence and validation, feed/tag cache access
    idb.ts            Per-row IndexedDB store, no dependencies
    format.ts         Duration, view count, and relative age formatting
    types.ts          Shared types, default rules, tags, and tuning constants
  components/
    Setup.tsx         One-time OAuth client ID entry with instructions
    Controls.tsx      Sort and filter bars for both views
    Tags.tsx          Tag filter row, manager panel, per-channel tag picker
    ChannelList.tsx   The channels view: one row per subscription
    VirtualGrid.tsx   Mounts only the rows near the viewport
    ConfirmDialog.tsx Modal with a delay before its destructive button arms
    VideoCard.tsx
  App.tsx        Refresh orchestration and layout
```

## Notes and limits

- Access tokens live one hour and are held in `sessionStorage`. The browser-only OAuth flow issues
  no refresh token, so a long session will re-authorize — usually silently, since Google can renew
  without a prompt while you are still signed in.
- Channel scanning reads at most two pages (100 videos) *per playlist* per channel per refresh,
  which bounds cost on very prolific channels.
- YouTube's `UU` uploads playlist is the union of `UULF` (long-form), `UUSH` (Shorts), and `UULV`
  (live). Only the long-form and live parts are read, which both keeps Shorts out and stops them
  consuming the page budget and starving older long-form uploads. These prefixes are undocumented,
  so a channel where they do not resolve falls back to `UU`, which comes back undivided — Shorts on
  that path are identified by the 3-minute ceiling and dropped from the feed, the one place a
  duration heuristic is still needed.
- Channels whose scan fails are reported in the status bar rather than silently omitted.
- Indexing runs in a Web Worker and writes to IndexedDB batch by batch, so closing the tab — or
  pressing Cancel — mid-index keeps what was already fetched; the next refresh resumes rather
  than re-requesting it. Unsubscribed channels are pruned only after a *completed* run, so an
  interrupted one never deletes anything.
- A cached video is re-requested only once its details are older than `METADATA_TTL_MS` (6h) and
  it was published within `METADATA_REFRESH_MAX_AGE_MS` (7 days), so view counts stay current
  without re-reading a whole back catalogue. Everything else in the cache costs nothing and is
  never re-fetched. New videos are always fetched ahead of stale ones.
- The grid is virtualized: only the rows near the viewport are mounted, with spacers standing in
  for the rest. Mounting a few thousand cards leaves the main thread unresponsive, and growing the
  list on scroll only defers that — flick to the bottom and every card is mounted again. Card
  height is fixed (`.card-title` is pinned to two lines) so row geometry can be measured once.
- Rules are validated field by field when read back from `localStorage`, not trusted. An entry
  written by an older build or edited by hand is dropped per-field rather than taken on faith: an
  unrecognized `sort` once reached the sort switch, returned `undefined`, and blanked the page on
  every load until storage was cleared by hand.
- Every cached channel and video row carries the `userId` of the signed-in YouTube account, and
  each account gets its own cache record. Signing in with a second account shows that account's
  feed without disturbing the first, and signing out does not discard anything.
- Only accounts on the **Test users** list can sign in; everyone else is refused with
  `access_denied`. To let another account in, add it to that list. Publishing the app instead would
  trigger Google verification, since `youtube.readonly` is a sensitive scope, and an unverified
  published app carries a lifetime cap of 100 new users that cannot be reset.
