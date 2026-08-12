import { useCallback, useEffect, useState } from 'react'

/**
 * Copy text to the clipboard and report success briefly.
 *
 * Clipboard access can be refused — an insecure origin, or a denied permission.
 * Both call sites show the text on screen anyway, so a failure just means the
 * confirmation does not appear; there is nothing to recover from.
 */
export function useCopy(resetAfterMs = 2000) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) {
      return
    }

    const timer = window.setTimeout(() => setCopied(false), resetAfterMs)

    return () => window.clearTimeout(timer)
  }, [copied, resetAfterMs])

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }, [])

  return { copied, copy }
}
