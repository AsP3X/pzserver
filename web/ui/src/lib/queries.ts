import { queryOptions } from '@tanstack/react-query'

import { api } from '@/lib/api'
import type { LeaderboardStat } from '@/lib/api'

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

export const leaderboardQuery = (
  stat: LeaderboardStat = 'zombie_kills',
  limit = 6,
) =>
  queryOptions({
    queryKey: ['stats', 'leaderboard', stat, limit],
    queryFn: () => api.leaderboard(stat, limit),
    staleTime: 60_000,
  })

/** The signed-in player's own character. Polled while the page is open. */
/**
 * The inventory snapshot. Polled while the page is open, because a refresh
 * lands as a file the mod writes a tick or two later rather than as a response.
 */
export const myInventoryQuery = queryOptions({
  queryKey: ['me', 'inventory'],
  queryFn: api.myInventory,
  refetchInterval: 10_000,
  refetchIntervalInBackground: false,
  staleTime: 5_000,
})

/**
 * The obituary, newest first. Not polled: a death that landed while you were
 * reading is not worth pulling the page out from under you, and the roll is
 * paged by cursor so an insert mid-scroll would shift nothing anyway.
 */
export const obituaryQuery = queryOptions({
  queryKey: ['obituary'],
  queryFn: () => api.obituary(),
  staleTime: 60_000,
})

export const obituarySummaryQuery = queryOptions({
  queryKey: ['obituary', 'summary'],
  queryFn: api.obituarySummary,
  staleTime: 60_000,
})

/**
 * The player's own position.
 *
 * Positions are exported every twelve ticks, about thirty real seconds. Asking
 * twice per export costs one file read and halves how long a moving player
 * looks like they are standing still.
 */
export const myPositionQuery = queryOptions({
  queryKey: ['me', 'position'],
  queryFn: api.myPosition,
  refetchInterval: 15_000,
  refetchIntervalInBackground: false,
  staleTime: 5_000,
})

export const myCharacterQuery = queryOptions({
  queryKey: ['me', 'character'],
  queryFn: api.myCharacter,
  // The vitals heartbeat is rewritten every four in-game minutes — about ten
  // real seconds — and this page is read by somebody playing right now, so it
  // follows the heartbeat rather than the slower stats export.
  refetchInterval: 10_000,
  refetchIntervalInBackground: false,
  // Below the poll interval, so a page returning to the foreground shows the
  // current reading rather than whatever was cached when it was hidden.
  staleTime: 5_000,
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
