// Google Identity Services OAuth 2.0 token flow for browser-only apps.
// No client secret, no backend: GIS hands us a short-lived access token.

const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'
const TOKEN_KEY = 'ytd.token'
const CLIENT_ID_KEY = 'ytd.clientId'

interface StoredToken {
  accessToken: string
  expiresAt: number
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string
            scope: string
            prompt?: string
            callback: (resp: TokenResponse) => void
            error_callback?: (err: { type?: string; message?: string }) => void
          }): TokenClient
          revoke(token: string, done?: () => void): void
        }
      }
    }
  }
}

export function getClientId(): string {
  return (
    localStorage.getItem(CLIENT_ID_KEY) ||
    (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ||
    ''
  )
}

export function setClientId(id: string): void {
  localStorage.setItem(CLIENT_ID_KEY, id.trim())
}

function readToken(): StoredToken | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY)
    if (!raw) return null
    const t = JSON.parse(raw) as StoredToken
    // Treat tokens expiring in the next 60s as already gone.
    return t.expiresAt - 60_000 > Date.now() ? t : null
  } catch {
    return null
  }
}

function writeToken(t: StoredToken): void {
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t))
}

export function hasValidToken(): boolean {
  return readToken() !== null
}

function waitForGis(timeoutMs = 10_000): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = window.setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        window.clearInterval(tick)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        window.clearInterval(tick)
        reject(new Error('Google Identity Services failed to load. Check your network or ad blocker.'))
      }
    }, 50)
  })
}

// Concurrent callers share one authorization attempt, so a token expiring
// mid-refresh cannot spawn a popup per in-flight request.
let inFlight: Promise<string> | null = null

/**
 * Returns a usable access token. `interactive: false` only succeeds when Google
 * can renew silently (an existing session that already granted the scope).
 */
export function getAccessToken(interactive: boolean): Promise<string> {
  const cached = readToken()
  if (cached) return Promise.resolve(cached.accessToken)
  if (inFlight) return inFlight

  inFlight = requestToken(interactive).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function requestToken(interactive: boolean): Promise<string> {
  const clientId = getClientId()
  if (!clientId) throw new Error('No Google OAuth client ID configured.')

  await waitForGis()

  return new Promise<string>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error_description || resp.error || 'Authorization failed.'))
          return
        }
        const token: StoredToken = {
          accessToken: resp.access_token,
          expiresAt: Date.now() + (resp.expires_in ?? 3600) * 1000,
        }
        writeToken(token)
        resolve(token.accessToken)
      },
      error_callback: (err) => reject(new Error(err.message || err.type || 'Authorization failed.')),
    })
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' })
  })
}

export function signOut(): void {
  const t = readToken()
  inFlight = null
  sessionStorage.removeItem(TOKEN_KEY)
  if (t && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(t.accessToken)
  }
}

/** Drop the cached token so the next call re-authorizes (used on a 401). */
export function invalidateToken(): void {
  inFlight = null
  sessionStorage.removeItem(TOKEN_KEY)
}
