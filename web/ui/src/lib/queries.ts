import { queryOptions } from '@tanstack/react-query'

import { api } from '@/lib/api'

/**
 * Live status is polled. The API caches each resolve for STATUS_CACHE_TTL
 * (5s by default), so polling faster than that only costs a JSON response —
 * the game server is not touched again.
 */
const STATUS_POLL_MS = 15_000

export const serverStatusQuery = queryOptions({
  queryKey: ['server', 'status'],
  queryFn: api.serverStatus,
  refetchInterval: STATUS_POLL_MS,
  // A backgrounded tab does not need to keep asking.
  refetchIntervalInBackground: false,
  staleTime: 5_000,
})

export const serverHistoryQuery = queryOptions({
  queryKey: ['server', 'history', 24],
  queryFn: () => api.serverHistory(24),
  // Samples are written every five minutes; anything finer is wasted work.
  staleTime: 5 * 60_000,
})

export const statsSummaryQuery = queryOptions({
  queryKey: ['stats', 'summary'],
  queryFn: api.statsSummary,
  staleTime: 60_000,
})

export const leaderboardQuery = queryOptions({
  queryKey: ['stats', 'leaderboard', 'zombie_kills', 6],
  queryFn: () => api.leaderboard('zombie_kills', 6),
  staleTime: 60_000,
})

/** The signed-in player's own character. Polled while the page is open. */
export const myCharacterQuery = queryOptions({
  queryKey: ['me', 'character'],
  queryFn: api.myCharacter,
  // The mod rewrites its export every ~25 real seconds on a running world.
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,
  staleTime: 15_000,
})

/**
 * Site copy for one locale. Keyed by locale so switching language swaps to a
 * separately cached copy instead of refetching over the same entry.
 */
export const siteQuery = (locale: string) =>
  queryOptions({
    queryKey: ['site', locale],
    queryFn: () => api.site(locale),
    // Copy changes when an admin edits it, which is rare.
    staleTime: 10 * 60_000,
  })
