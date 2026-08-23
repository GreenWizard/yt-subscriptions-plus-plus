# YouTube Decomposer

Your YouTube subscription feed, on your rules. No algorithm, no Shorts unless you ask, and
sorting that goes beyond "newest".

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
| Longest / Shortest first | Runtime. |

**Filtering**

- **Hide Shorts** — drops anything 60 seconds or under.
- **Length window** — min/max minutes (leave max at 0 for no upper bound).
- **Lookback** — how many days back the feed reaches, 1–90.
- **Search** — substring match on video title or channel name.

Rules persist in `localStorage`, so the feed opens the way you left it.

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
   account. Leave the publishing status on **Testing**; a test user can use the app indefinitely
   and no Google verification is required.
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

A full refresh costs roughly `1 + N` units for `N` subscribed channels — about 300 units at 300
subscriptions, so ~30 full refreshes a day. The app keeps that low by:

- deriving each channel's uploads playlist ID from its channel ID (`UC…` → `UU…`) instead of
  spending a `channels.list` call per channel;
- reading only video IDs and publish dates while scanning channels, then fetching full details for
  videos it has not already cached;
- stopping pagination as soon as a channel's uploads fall outside the lookback window;
- caching subscriptions for 12 hours and video metadata in IndexedDB.

Refreshes after the first are much cheaper, since only genuinely new videos need details fetched.

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
    auth.ts      Google Identity Services token flow (no client secret)
    youtube.ts   YouTube Data API v3 client, quota-conscious feed assembly
    rules.ts     Sorting and filtering — the actual "my own rules" logic
    store.ts     Rule persistence, IndexedDB feed cache, merge and prune
    idb.ts       ~50-line IndexedDB key/value helper, no dependencies
    format.ts    Duration, view count, and relative age formatting
    types.ts     Shared types and default rules
  components/
    Setup.tsx    One-time OAuth client ID entry with instructions
    Controls.tsx Sort and filter bar
    VideoCard.tsx
  App.tsx        Refresh orchestration and layout
```

## Deploying

`npm run build` emits a fully static `dist/`, deployable to GitHub Pages, Vercel, Netlify, or any
static host. Add the deployed origin to **Authorized JavaScript origins** under
**Google Auth Platform → Clients → your client**, alongside the localhost entries.

## Notes and limits

- Access tokens live one hour and are held in `sessionStorage`. The browser-only OAuth flow issues
  no refresh token, so a long session will re-authorize — usually silently, since Google can renew
  without a prompt while you are still signed in.
- Live streams report a zero duration and are exempt from the length filters, so they never get
  filtered out for being "too short".
- Channel scanning reads at most two pages (100 videos) per channel per refresh, which bounds cost
  on very prolific channels.
- The lookback window filters the cached feed, but widening it past what has already been fetched
  needs a **Refresh** to pull the older videos in.
