import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { useCurrentUser } from '@/lib/auth'

/**
 * Send signed-out visitors to the login page.
 *
 * Guards run as an effect rather than in a route loader because `/auth/me` is
 * an ordinary query: waiting for its answer keeps a signed-in user who arrived
 * by deep link from being bounced out before the session resolves.
 */
export function useRequireUser() {
  const navigate = useNavigate()
  const { user, isLoading } = useCurrentUser()

  useEffect(() => {
    if (!isLoading && !user) {
      void navigate({ to: '/login', replace: true })
    }
  }, [isLoading, user, navigate])

  return { user, isLoading }
}

/** Keep already-signed-in visitors off the sign-in and registration pages. */
export function useRedirectSignedIn() {
  const navigate = useNavigate()
  const { user, isLoading } = useCurrentUser()

  useEffect(() => {
    if (!isLoading && user) {
      void navigate({ to: '/', replace: true })
    }
  }, [isLoading, user, navigate])
}
