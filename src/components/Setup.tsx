import { useState } from 'react'
import { getClientId, setClientId } from '../lib/auth'

interface Props {
  onReady: () => void
}

export function Setup({ onReady }: Props) {
  const [value, setValue] = useState(getClientId())
  const origin = window.location.origin

  function save() {
    const id = value.trim()
    if (!id) return
    setClientId(id)
    onReady()
  }

  return (
    <div className="setup">
      <h1>
        One-time setup
      </h1>
      <p className="lead">
        This app talks to YouTube straight from your browser, so it needs your own free Google OAuth
        client ID. Nothing is sent anywhere else.
      </p>
      <ol>
        <li>
          Open the <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">
            Google Cloud Console
          </a> and create a project.
        </li>
        <li>
          In <em>APIs &amp; Services → Library</em>, enable <code>YouTube Data API v3</code>.
        </li>
        <li>
          In <em>APIs &amp; Services → OAuth consent screen</em>, choose <strong>External</strong>, fill in
          the required fields, add the scope <code>youtube.readonly</code>, and add your own Google
          account as a <strong>test user</strong>.
        </li>
        <li>
          In <em>Credentials → Create credentials → OAuth client ID</em>, pick{' '}
          <strong>Web application</strong> and add <code>{origin}</code> under{' '}
          <em>Authorized JavaScript origins</em>.
        </li>
        <li>Paste the client ID below.</li>
      </ol>
      <div className="row">
        <input
          type="text"
          placeholder="123456789-abcdef.apps.googleusercontent.com"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <button className="primary" onClick={save} disabled={!value.trim()}>
          Save
        </button>
      </div>
    </div>
  )
}
