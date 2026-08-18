/** Session queries and mutations. */
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { api, type LoginInput, type RegisterInput, type User } from '@/lib/api'

export const currentUserQuery = queryOptions({
  queryKey: ['auth', 'me'],
  queryFn: api.currentUser,
  // Cheap and central: every page reads it, and a stale answer means showing
  // the wrong header.
  staleTime: 30_000,
  retry: false,
})

interface CurrentUser {
  user: User | null
  isLoading: boolean
}

export function useCurrentUser(): CurrentUser {
  const { data, isPending } = useQuery(currentUserQuery)

  return { user: data?.user ?? null, isLoading: isPending }
}

/**
 * Replace the cached session after signing in or out.
 *
 * The user comes back in the login response, so seeding the cache directly
 * avoids a second round trip before the header updates; everything else is
 * invalidated because it may render differently when signed in.
 */
function useSessionChange() {
  const queryClient = useQueryClient()

  return (user: User | null) => {
    queryClient.setQueryData(currentUserQuery.queryKey, { user })
    void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'auth' })
  }
}

/**
 * Sign in with a password.
 *
 * Only updates the session when one was actually issued: with two-factor on the
 * server answers `two_factor_required` and no cookie is set, so treating that
 * as a login would show a signed-in header over a session that does not exist.
 * The caller is responsible for taking the challenge to [`useAnswerTwoFactor`].
 */
export function useLogin() {
  const onSession = useSessionChange()

  return useMutation({
    mutationFn: (input: LoginInput) => api.login(input),
    onSuccess: (response) => {
      if (response.status === 'signed_in') {
        onSession(response.user)
      }
    },
  })
}

/**
 * Second step of a two-factor sign-in: a code in exchange for a session.
 *
 * `challenge` is null when the sign-in came through Steam — that path leaves
 * the token in an httpOnly cookie the browser sends automatically, precisely so
 * it never has to travel through a URL.
 */
export function useAnswerTwoFactor() {
  const onSession = useSessionChange()

  return useMutation({
    mutationFn: ({ challenge, code }: { challenge: string | null; code: string }) =>
      api.answerTwoFactor(challenge, code),
    onSuccess: (response) => onSession(response.user),
  })
}

export function useRegister() {
  const onSession = useSessionChange()

  return useMutation({
    mutationFn: (input: RegisterInput) => api.register(input),
    onSuccess: (response) => onSession(response.user),
  })
}

export function useLogout() {
  const onSession = useSessionChange()

  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => onSession(null),
  })
}

export function useChangePassword() {
  return useMutation({
    mutationFn: api.changePassword,
  })
}
