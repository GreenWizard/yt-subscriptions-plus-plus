import { useEffect, useRef, useState } from 'react'

interface Props {
  title: string
  message: string
  confirmLabel: string
  /** Seconds the confirm button stays disabled, so a reflex click cannot fire it. */
  delaySec: number
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  delaySec,
  onConfirm,
  onCancel,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  // A deadline rather than a tick count: an interval in a backgrounded tab is
  // throttled, and counting its ticks would stretch the delay arbitrarily.
  const deadline = useRef(Date.now() + delaySec * 1000)
  const [left, setLeft] = useState(delaySec)

  // showModal, not the `open` attribute: it is what gives the backdrop, the
  // focus trap, and Escape.
  useEffect(() => ref.current?.showModal(), [])

  useEffect(() => {
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000))
      setLeft(remaining)
      if (remaining === 0) clearInterval(id)
    }, 200)
    return () => clearInterval(id)
  }, [])

  return (
    <dialog
      className="confirm"
      ref={ref}
      // Escape reaches the dialog directly; route it through the same cancel
      // path so the caller always learns the dialog is gone.
      onCancel={(e) => {
        e.preventDefault()
        onCancel()
      }}
    >
      <h2>{title}</h2>
      <p>{message}</p>
      <div className="row">
        <button onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button className="danger" onClick={onConfirm} disabled={left > 0}>
          {left > 0 ? `${confirmLabel} (${left})` : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
