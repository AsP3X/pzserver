import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { useCurrentUser } from '@/lib/auth'
import { canAdminister } from '@/lib/navigation'

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

/**
 * Staff only.
 *
 * A signed-in player who guesses an `/admin` URL goes to their own area rather
 * than the login page — they are not short of credentials, they are in the
 * wrong place, and bouncing them to a login form they have already passed
 * would just be confusing.
 */
export function useAdminOnly() {
  const navigate = useNavigate()
  const { user, isLoading } = useCurrentUser()

  const allowed = canAdminister(user?.role)

  useEffect(() => {
    if (isLoading) {
      return
    }

    if (!user) {
      void navigate({ to: '/login', replace: true })

      return
    }

    if (!allowed) {
      void navigate({ to: '/me', replace: true })
    }
  }, [isLoading, user, allowed, navigate])

  return { user, allowed, isLoading }
}
