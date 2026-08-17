import { useEffect } from 'react'
import { XIcon } from './Icons'

const AUTO_DISMISS_MS = 8_000

type Props = {
  message: string
  onDismiss: () => void
}

export function ErrorToast({ message, onDismiss }: Props) {
  useEffect(() => {
    const id = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(id)
  }, [message, onDismiss])

  return (
    <div className="error-toast" role="alert">
      <span className="error-toast-text">{message}</span>
      <button type="button" className="error-toast-close" onClick={onDismiss} aria-label="Dismiss">
        <XIcon size={9} />
      </button>
    </div>
  )
}
