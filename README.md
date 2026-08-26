# yt-subscriptions++

Your YouTube subscription feed, on your rules. No algorithm, no Shorts, and sorting that goes
beyond "newest".

It is a static single-page app: your browser talks to the YouTube Data API directly. There is no
backend, no database, and no third party in the middle. Your subscriptions and the feed cache
never leave your machine.

## What it does

**Sorting**

| Sort | What it means |
| --- | --- |
| Newest / Oldest first | Publish date. |
| Most views | Absolute view count. |
| Trending (views/hour) | Views divided by hours since publication — surfaces what is taking off right now instead of what is merely old and popular. |

**Shuffle page** re-deals the page on screen into a random order — it is a button, not a sort, so
leaving the page or changing a rule un-shuffles.

**Filtering**

- **Release date** — inclusive from/to window, with presets, in your own timezone.
- **Search** — substring match on video title or channel name.
- **Tags** — pick any number of your channel tags; a Match switch chooses between *any* (OR) and
  *all* (AND) semantics when several are selected.
- **Muting** — a muted channel disappears from the feed but stays in the channels view, where
  muting is undone.

Shorts are not a filter: they are never fetched, so there is nothing to toggle.

Rules persist in `localStorage`, so the feed opens the way you left it.

**Channel tags**

Label your subscriptions and filter the feed by those labels. Up to 10 tags per channel; every
video inherits its channel's tags. Each tag wears one of 32 palette colors, with the chip text
flipping between dark and light by the color's luminance. Tags are created, renamed, recolored and
deleted in the **channels** view (where they are assigned), and live in IndexedDB next to the feed
cache — per account, surviving refreshes and cache clears. Filtering stays flat-cost at feed
scale: the selected tags collapse to one set of admitted channels, a single lookup per video even
at 200k videos.

**Channels view**

One row per subscription — newest uploads, indexed count, latest-upload age — searchable and
sortable by recency or name, with per-channel tag assignment and muting.

**Mobile**

The whole controls block slides away when scrolling down and returns on the first scroll up. The
header never wraps: on narrow viewports the counters drop to their own row and the Refresh label
becomes an icon. Rarely used actions (Clear cache, Sign out) sit in a ☰ menu in the corner. A
running refresh can be cancelled by pressing the button again — everything already indexed stays
cached.

## Setup

You need your own Google OAuth client ID. It is free, takes about five minutes, and is required
because the app has no server to hold credentials for you.

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
   **Authorized JavaScript origins** add both `http://localhost:5173` and `http://localhost` —
   Google asks for the bare host as well as the port-specific origin when testing locally. Leave
   **Authorized redirect URIs** empty; the Google Identity Services token flow does not use them.
7. Copy the client ID.

Then:

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

## Deploying

`npm run build` emits a fully static `dist/`, deployable to GitHub Pages, Vercel, Netlify, or any
static host. Add the deployed origin to **Authorized JavaScript origins** under
**Google Auth Platform → Clients → your client**, alongside the localhost entries.

### GitHub Pages

A project page is served from `https://<user>.github.io/<repo>/` — a subpath, not the origin
root — so the build needs Vite's `--base` flag; everything else is the stock Pages/Actions flow.

1. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Commit this workflow as `.github/workflows/pages.yml`:

   ```yaml
   name: Deploy to GitHub Pages

   on:
     push:
       branches: [main]
     workflow_dispatch:

   permissions:
     contents: read
     pages: write
     id-token: write

   concurrency:
     group: pages
     cancel-in-progress: true

   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 22
             cache: npm
         - run: npm ci
         # --base makes asset URLs resolve under the /<repo>/ subpath.
         - run: npm run build -- --base=/${{ github.event.repository.name }}/
         - uses: actions/upload-pages-artifact@v3
           with:
             path: dist
     deploy:
       needs: build
       runs-on: ubuntu-latest
       environment:
         name: github-pages
         url: ${{ steps.deployment.outputs.page_url }}
       steps:
         - id: deployment
           uses: actions/deploy-pages@v4
   ```

3. Push to `main`. The workflow builds `dist/` and publishes it; the URL appears on the
   workflow run and under **Settings → Pages**.
4. Add `https://<user>.github.io` to **Authorized JavaScript origins** on your OAuth client
   (origins carry no path, so the bare `github.io` host of your account is the whole entry).
   Also allow popups for that origin — sign-in still uses one.
5. Open the page and paste your client ID into the setup screen, exactly as on localhost. The
   ID is stored in your browser's `localStorage`, not in the repo. (Baking it in at build time
   also works — define `VITE_GOOGLE_CLIENT_ID` as a repository **variable** and pass it in the
   build step's `env` — but is only worth it if you are tired of the setup screen; a client ID
   is public by design, though anyone who copies yours shares your daily quota.)

Two things do not change from localhost: only Google accounts on the **Test users** list can
sign in (see the note below), and the feed cache stays in each visitor's own browser — hosting
the page publicly shares the code, not your data.

To deploy without Actions, build locally and publish `dist/` to a `gh-pages` branch
(`npx gh-pages -d dist` after building with the same `--base` flag), then point
**Settings → Pages** at that branch — same result, just manual.

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
