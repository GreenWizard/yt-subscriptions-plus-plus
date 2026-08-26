// Test seam for exercising the feed without the real YouTube API. Installs a
// `fetch` interceptor in the worker's global scope, so `apiGet` runs unchanged
// and its real 401-retry / 403-quota / 404-fallback branches fire. Gated behind
// VITE_YT_MOCK; a normal build has it fully inert.
//
// Usage:  VITE_YT_MOCK=quota:3 npm run dev
//         VITE_YT_MOCK=fixtures:20x100 npm run dev
//
// Scenarios (value of VITE_YT_MOCK):
//   quota[:N]        requests 1..N succeed for real, then every request returns
//                    403 quotaExceeded. N defaults to 0 (quota out immediately).
//   auth             the first request returns 401 once (tests invalidate +
//                    retry), everything after passes through to the real API.
//   404              every playlistItems request returns 404 (tests the UU
//                    fallback), everything else passes through.
//   fixtures[:CxV]   FULLY OFFLINE. Synthesizes C channels each with V videos —
//                    no network, no real auth, no quota burned. Defaults 10x30.
//
// The quota/auth/404 scenarios pass non-matching requests through to the real
// API (real auth still works). The fixtures scenario mocks everything and also
// short-circuits auth, so the app runs with no Google account at all.

import { decodePageToken, encodePageToken, setAuthBridge } from './youtube'

const API_HOST = 'www.googleapis.com'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, message: string, reason?: string): Response {
  return jsonResponse({ error: { message, errors: reason ? [{ reason }] : [] } }, status)
}

const quota = () =>
  errorResponse(403, 'The request cannot be completed because you have exceeded your quota.', 'quotaExceeded')

/** Install the interceptor described by VITE_YT_MOCK, if any. Call once, early. */
export function installFeedMock(): void {
  const spec = import.meta.env.VITE_YT_MOCK as string | undefined
  if (!spec) return

  const [name, arg] = spec.split(':')

  if (name === 'fixtures') {
    installFixtures(arg)
    console.info(`[feed-mock] installed offline fixtures "${spec}"`)
    return
  }

  const real = globalThis.fetch.bind(globalThis)
  let calls = 0
  let auth401Fired = false

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes(API_HOST)) return real(input, init)

    calls++
    switch (name) {
      case 'quota': {
        if (calls <= Number(arg ?? 0)) return real(input, init)
        console.warn(`[feed-mock] quota 403 for call #${calls}: ${url}`)
        return quota()
      }
      case 'auth': {
        if (!auth401Fired) {
          auth401Fired = true
          console.warn(`[feed-mock] one-shot 401 for call #${calls}: ${url}`)
          return errorResponse(401, 'Invalid Credentials', 'authError')
        }
        return real(input, init)
      }
      case '404': {
        if (url.includes('/playlistItems')) {
          console.warn(`[feed-mock] 404 for call #${calls}: ${url}`)
          return errorResponse(404, 'Playlist not found.', 'playlistNotFound')
        }
        return real(input, init)
      }
      default:
        console.warn(`[feed-mock] unknown scenario "${name}"; passing through`)
        return real(input, init)
    }
  }

  console.info(`[feed-mock] installed scenario "${spec}"`)
}

// --- Offline fixtures -------------------------------------------------------

const USER_ID = 'UC00000000000000000000ME'
const PAGE = 50

/** Deterministic 24-char UC channel id from an index. */
const channelId = (i: number) => 'UC' + String(i).padStart(22, '0')
/** Recover the channel index from a channel id (inverse of channelId). */
const channelIndex = (id: string) => Number(id.slice(2))

/** A tiny distinct SVG thumbnail so cards render offline (no network image). */
function thumb(hue: number, label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">` +
    `<rect width="320" height="180" fill="hsl(${hue},60%,45%)"/>` +
    `<text x="160" y="100" font-size="28" fill="white" text-anchor="middle" font-family="sans-serif">${label}</text>` +
    `</svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

function installFixtures(arg?: string): void {
  // `CxV[lL][+CxV[lL]…]`: any number of channel groups, each C channels with V
  // long-form videos (and optionally L live streams) apiece, laid out at
  // consecutive indices. Groups let tests grow the subscription list — a spec
  // extended with another `+CxV` adds "new" channels while every channel from
  // the shorter spec keeps its exact ids and counts.
  const groups = (arg ?? '10x30')
    .split('+')
    .map((g) => /^(\d+)x(\d+)(?:l(\d+))?$/.exec(g))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ count: Number(m[1]), videos: Number(m[2]), live: m[3] ? Number(m[3]) : 0 }))
  // Not capped: playlistItems here paginates through the whole count, so the
  // backfill pass (which reads every page) has a full back catalogue to fetch.
  if (groups.length === 0) groups.push({ count: 10, videos: 30, live: 0 })

  const channelCount = groups.reduce((sum, g) => sum + g.count, 0)
  const groupOf = (i: number) => {
    let start = 0
    for (const g of groups) {
      if (i < start + g.count) return g
      start += g.count
    }
    return groups[groups.length - 1]
  }
  const longCount = (i: number) => groupOf(i).videos
  const liveCount = (i: number) => groupOf(i).live

  // No round trip to the main thread / Google Identity Services: any string works
  // because the interceptor never validates the token.
  setAuthBridge({
    async getToken() {
      return 'fixture-token'
    },
    invalidate() {},
  })

  // Each YouTube Data API .list call costs 1 quota unit, so tallying calls per
  // endpoint is the quota cost of a refresh. Logged cumulatively; the last line
  // after a run settles is the total.
  const tally: Record<string, number> = {}

  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!raw.includes(API_HOST)) return errorResponse(502, 'fixtures mode: no network')
    const url = new URL(raw)
    const q = url.searchParams

    const endpoint = url.pathname.split('/').pop() ?? '?'
    tally[endpoint] = (tally[endpoint] ?? 0) + 1
    const total = Object.values(tally).reduce((a, b) => a + b, 0)
    console.debug(`[quota] total=${total} ${JSON.stringify(tally)}`)

    // channels?mine=true — the account's own channel.
    if (url.pathname.endsWith('/channels')) {
      return jsonResponse({ items: [{ id: USER_ID, snippet: { title: 'Fixture User' } }] })
    }

    // subscriptions — C channels, 50 per page. Tokens use the real API's
    // base64-protobuf offset encoding so the parallel page-guessing path is
    // exercised exactly as it would be against Google.
    if (url.pathname.endsWith('/subscriptions')) {
      const raw = q.get('pageToken')
      const offset = raw ? decodePageToken(raw) : 0
      if (!Number.isFinite(offset)) return errorResponse(400, 'Invalid page token.', 'invalidPageToken')
      const slice = Array.from({ length: Math.min(PAGE, channelCount - offset) }, (_, k) => {
        const i = offset + k
        return {
          snippet: {
            title: `Channel ${i}`,
            resourceId: { channelId: channelId(i) },
            thumbnails: { medium: { url: thumb((i * 37) % 360, `C${i}`) } },
          },
          // Upload count the scan-skip optimization diffs against. Deterministic,
          // so a second refresh sees it unchanged and skips the playlist scan.
          contentDetails: { totalItemCount: longCount(i) + liveCount(i) },
        }
      })
      const next = offset + PAGE < channelCount ? encodePageToken(offset + PAGE) : undefined
      return jsonResponse({
        items: slice,
        pageInfo: { totalResults: channelCount },
        ...(next ? { nextPageToken: next } : {}),
      })
    }

    // playlistItems — the long-form playlist pages through the channel's videos;
    // the live playlist serves live stream ids for extra channels that have any
    // and 404s otherwise, which apiGet tolerates per kind.
    if (url.pathname.endsWith('/playlistItems')) {
      const playlistId = q.get('playlistId') ?? ''
      const isLivePl = playlistId.startsWith('UULV')
      if (!isLivePl && !playlistId.startsWith('UULF')) {
        return errorResponse(404, 'Playlist not found.', 'playlistNotFound')
      }
      const chIdx = channelIndex('UC' + playlistId.slice(4))
      const count = isLivePl ? liveCount(chIdx) : longCount(chIdx)
      if (count === 0) return errorResponse(404, 'Playlist not found.', 'playlistNotFound')
      const rawToken = q.get('pageToken')
      const offset = rawToken ? decodePageToken(rawToken) : 0
      if (!Number.isFinite(offset)) return errorResponse(400, 'Invalid page token.', 'invalidPageToken')
      const prefix = isLivePl ? 'vl' : 'v'
      // Newest-first like the real auto-playlists: position 0 is the highest
      // sequence number, so raising a channel's count adds a NEW id at the head
      // (where a refresh's single-page scan will see it) instead of an old one
      // at the tail.
      const slice = Array.from({ length: Math.max(0, Math.min(PAGE, count - offset)) }, (_, k) => ({
        contentDetails: { videoId: `${prefix}_${chIdx}_${count - 1 - (offset + k)}` },
      }))
      const next = offset + PAGE < count ? encodePageToken(offset + PAGE) : undefined
      return jsonResponse({
        items: slice,
        pageInfo: { totalResults: count },
        ...(next ? { nextPageToken: next } : {}),
      })
    }

    // videos — details for a comma-separated id list.
    if (url.pathname.endsWith('/videos')) {
      const ids = (q.get('id') ?? '').split(',').filter(Boolean)
      const now = Date.now()
      const items = ids.map((id) => {
        const [prefix, ch, n] = id.split('_')
        const isLiveVideo = prefix === 'vl'
        const chIdx = Number(ch)
        const seq = Number(n)
        // Live streams run long; of the rest, every 5th video is a Short.
        const durationSec = isLiveVideo ? 7200 : seq % 5 === 0 ? 45 : 600 + seq * 7
        const h = Math.floor(durationSec / 3600)
        const m = Math.floor((durationSec % 3600) / 60)
        const s = durationSec % 60
        const duration = `PT${h ? h + 'H' : ''}${m ? m + 'M' : ''}${s ? s + 'S' : ''}` || 'PT0S'
        return {
          id,
          snippet: {
            title: `Channel ${chIdx} — ${isLiveVideo ? 'stream' : 'video'} ${seq}`,
            channelId: channelId(chIdx),
            channelTitle: `Channel ${chIdx}`,
            // Spread uploads across recent days so ordering has something to
            // work with. Higher sequence = newer, matching the reversed
            // newest-first playlist order above.
            publishedAt: new Date(
              now - (chIdx * longCount(chIdx) + (longCount(chIdx) - seq)) * 3600_000,
            ).toISOString(),
            thumbnails: { medium: { url: thumb((chIdx * 37 + seq * 11) % 360, `${chIdx}·${seq}`) } },
          },
          contentDetails: { duration },
          statistics: { viewCount: String((seq + 1) * 137 + chIdx * 1000) },
        }
      })
      return jsonResponse({ items })
    }

    return errorResponse(404, `fixtures mode: unhandled ${url.pathname}`)
  }
}
