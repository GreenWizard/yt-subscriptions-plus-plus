import { useState } from 'react'
import { getClientId, setClientId } from '../lib/auth'

interface Props {
  onReady: () => void
}

export function Setup({ onReady }: Props) {
  const [value, setValue] = useState(getClientId())
  const origin = window.location.origin
  const isLocalhost = /^https?:\/\/localhost(:\d+)?$/.test(origin)

  function save() {
    const id = value.trim()
    if (!id) return
    setClientId(id)
    onReady()
  }

  return (
    <div className="setup">
      <h1>One-time setup</h1>
      <p className="lead">
        This app talks to YouTube straight from your browser, so it needs your own free Google OAuth
        client ID. Nothing is sent anywhere else.
      </p>
      <ol>
        <li>
          Create a project in the{' '}
          <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">
            Google Cloud Console
          </a>
          .
        </li>
        <li>
          In <em>APIs &amp; Services → Library</em>, enable <code>YouTube Data API v3</code>.
        </li>
        <li>
          Open{' '}
          <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">
            Google Auth Platform
          </a>{' '}
          and click <strong>Get started</strong>. Give the app a name and a support email, then set{' '}
          <em>Audience</em> to <strong>External</strong> and finish the wizard.
        </li>
        <li>
          On the <em>Data Access</em> page, choose <strong>Add or remove scopes</strong> and add{' '}
          <code>.../auth/youtube.readonly</code>.
        </li>
        <li>
          On the <em>Audience</em> page, under <strong>Test users</strong>, add your own Google
          account. Leave the publishing status on <strong>Testing</strong> — no verification needed.
        </li>
        <li>
          On the <em>Clients</em> page, click <strong>Create client</strong> and pick{' '}
          <strong>Web application</strong>. Under <em>Authorized JavaScript origins</em> add{' '}
          <code>{origin}</code>
          {isLocalhost && (
            <>
              {' '}
              and <code>http://localhost</code>
            </>
          )}
          . Leave the redirect URIs empty.
        </li>
        <li>Copy the client ID and paste it below.</li>
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
