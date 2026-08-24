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

export const adminPlayersQuery = queryOptions({
  queryKey: ['admin', 'players'],
  queryFn: api.adminPlayers,
  refetchInterval: 10_000,
  refetchIntervalInBackground: false,
  staleTime: 5_000,
})

export const adminConfigQuery = queryOptions({
  queryKey: ['admin', 'config'],
  queryFn: api.adminConfig,
  staleTime: 15_000,
})

export const adminSandboxQuery = queryOptions({
  queryKey: ['admin', 'config', 'sandbox'],
  queryFn: api.adminSandbox,
  staleTime: 15_000,
})

export const adminModsQuery = queryOptions({
  queryKey: ['admin', 'mods'],
  queryFn: api.adminMods,
  staleTime: 15_000,
})

export const adminBridgeQuery = queryOptions({
  queryKey: ['admin', 'bridge'],
  queryFn: api.adminBridge,
  refetchInterval: 15_000,
  refetchIntervalInBackground: false,
  staleTime: 5_000,
})

/**
 * The item catalogue only moves when the game server boots, so once fetched it
 * is good for the session. Not `Infinity`, though — a restart while the tab is
 * open should eventually be noticed.
 */
export const adminItemsQuery = queryOptions({
  queryKey: ['admin', 'items'],
  queryFn: api.adminItems,
  staleTime: 30 * 60_000,
})

export const itemsQuery = queryOptions({
  queryKey: ['items'],
  queryFn: api.items,
  staleTime: 30 * 60_000,
})

export const adminLogsQuery = (tail: number) =>
  queryOptions({
    queryKey: ['admin', 'logs', tail],
    queryFn: () => api.adminLogs(tail),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    staleTime: 2_000,
  })

export const adminSanctionsQuery = queryOptions({
  queryKey: ['admin', 'sanctions'],
  queryFn: api.adminSanctions,
  refetchInterval: 15_000,
  refetchIntervalInBackground: false,
  staleTime: 5_000,
})

export const adminEventsQuery = (input: {
  types: Array<'death' | 'pvp_kill'>
  from?: string
  to?: string
}) =>
  queryOptions({
    queryKey: ['admin', 'events', input],
    queryFn: () => api.adminEvents(input),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  })

export const adminSiteQuery = queryOptions({
  queryKey: ['admin', 'site'],
  queryFn: api.adminSite,
  staleTime: 30_000,
})

export const adminReportsQuery = queryOptions({
  queryKey: ['admin', 'reports'],
  queryFn: api.adminReports,
  refetchInterval: 20_000,
  refetchIntervalInBackground: false,
  staleTime: 5_000,
})

export const myReportsQuery = queryOptions({
  queryKey: ['me', 'reports'],
  queryFn: api.myReports,
  refetchInterval: 15_000,
  refetchIntervalInBackground: false,
  staleTime: 5_000,
})

export const adminBackupsQuery = queryOptions({
  queryKey: ['admin', 'backups'],
  queryFn: api.adminBackups,
  refetchInterval: (query) => (query.state.data?.job ? 3_000 : 15_000),
  refetchIntervalInBackground: false,
  staleTime: 2_000,
})

export const adminBackupScheduleQuery = queryOptions({
  queryKey: ['admin', 'backups', 'schedule'],
  queryFn: api.adminBackupSchedule,
  staleTime: 15_000,
})

export const adminAutomationsQuery = queryOptions({
  queryKey: ['admin', 'automations'],
  queryFn: api.adminAutomations,
  refetchInterval: 15_000,
  refetchIntervalInBackground: false,
  staleTime: 5_000,
})

export const adminAuditQuery = (filter: { actor?: string; action?: string; target?: string }) =>
  queryOptions({
    queryKey: ['admin', 'audit', filter],
    queryFn: () => api.adminAudit(filter),
    refetchInterval: 15_000,
    staleTime: 5_000,
  })

export const adminAuditActionsQuery = queryOptions({
  queryKey: ['admin', 'audit', 'actions'],
  queryFn: api.adminAuditActions,
  staleTime: 30_000,
})

export function adminAutomationRunsQuery(id: string) {
  return queryOptions({
    queryKey: ['admin', 'automations', id, 'runs'],
    queryFn: () => api.adminAutomationRuns(id),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
    enabled: id.length > 0,
  })
}

export const myWalletQuery = queryOptions({
  queryKey: ['me', 'wallet'],
  queryFn: api.myWallet,
  refetchInterval: 15_000,
  staleTime: 5_000,
})

export const myWalletTransactionsQuery = queryOptions({
  queryKey: ['me', 'wallet', 'transactions'],
  queryFn: api.myWalletTransactions,
  refetchInterval: 15_000,
  staleTime: 5_000,
})

export const myRewardsQuery = queryOptions({
  queryKey: ['me', 'rewards'],
  queryFn: api.myRewards,
  refetchInterval: 15_000,
  staleTime: 5_000,
})

/**
 * Polled a little faster than the rest of the wallet: a player who has just
 * asked to bank cash is watching this line waiting for it to clear, and the
 * mod resolves it within a tick or two of them being online.
 */
export const depositPreviewQuery = queryOptions({
  queryKey: ['me', 'deposit'],
  queryFn: api.depositPreview,
  refetchInterval: 10_000,
  staleTime: 2_000,
})

export const myDepositsQuery = queryOptions({
  queryKey: ['me', 'deposit', 'history'],
  queryFn: api.myDeposits,
  refetchInterval: 30_000,
  staleTime: 5_000,
})

export const playerProfileQuery = (username: string) =>
  queryOptions({
    queryKey: ['stats', 'player', username.toLowerCase()],
    queryFn: () => api.playerProfile(username),
    staleTime: 30_000,
    // A name that is not a survivor stays not a survivor; retrying is noise.
    retry: false,
  })

export const adminUpdateStatusQuery = queryOptions({
  queryKey: ['admin', 'update'],
  queryFn: api.adminUpdateStatus,
  staleTime: 60_000,
})

export const twoFactorStatusQuery = queryOptions({
  queryKey: ['auth', '2fa'],
  queryFn: api.twoFactorStatus,
  staleTime: 30_000,
})

export const adminRespawnQuery = queryOptions({
  queryKey: ['admin', 'respawn'],
  queryFn: api.adminRespawn,
  refetchInterval: 30_000,
  staleTime: 10_000,
})

export const adminDepositsQuery = queryOptions({
  queryKey: ['admin', 'deposits'],
  queryFn: api.adminDeposits,
  refetchInterval: 15_000,
  staleTime: 5_000,
})

export const storeItemsQuery = queryOptions({
  queryKey: ['store', 'items'],
  queryFn: api.storeItems,
  refetchInterval: 8_000,
  staleTime: 4_000,
})

export const myStorePurchasesQuery = queryOptions({
  queryKey: ['me', 'store', 'purchases'],
  queryFn: api.myStorePurchases,
  refetchInterval: 10_000,
  staleTime: 5_000,
})

export const auctionsQuery = queryOptions({
  queryKey: ['auctions'],
  queryFn: api.auctions,
  refetchInterval: 8_000,
  staleTime: 4_000,
})

export const myAuctionsQuery = queryOptions({
  queryKey: ['auctions', 'mine'],
  queryFn: api.myAuctions,
  refetchInterval: 8_000,
  staleTime: 4_000,
})

export const buyOffersQuery = queryOptions({
  queryKey: ['auctions', 'offers'],
  queryFn: api.buyOffers,
  refetchInterval: 8_000,
  staleTime: 4_000,
})

export const myBuyOffersQuery = queryOptions({
  queryKey: ['auctions', 'offers', 'mine'],
  queryFn: api.myBuyOffers,
  refetchInterval: 8_000,
  staleTime: 4_000,
})

export const myVaultQuery = queryOptions({
  queryKey: ['me', 'vault'],
  queryFn: api.myVault,
  refetchInterval: 8_000,
  refetchIntervalInBackground: false,
  staleTime: 4_000,
})

export const adminVaultQuery = queryOptions({
  queryKey: ['admin', 'vault'],
  queryFn: api.adminVault,
  staleTime: 5_000,
})

export const adminStoreQuery = queryOptions({
  queryKey: ['admin', 'store'],
  queryFn: api.adminStoreItems,
  staleTime: 5_000,
})

export const adminStorePurchasesQuery = queryOptions({
  queryKey: ['admin', 'store', 'purchases'],
  queryFn: api.adminStorePurchases,
  refetchInterval: 15_000,
  staleTime: 5_000,
})

export const adminWalletsQuery = queryOptions({
  queryKey: ['admin', 'wallets'],
  queryFn: api.adminWallets,
  refetchInterval: 15_000,
  staleTime: 5_000,
})

export const adminQuestsQuery = queryOptions({
  queryKey: ['admin', 'quests'],
  queryFn: api.adminQuests,
  staleTime: 5_000,
})

export function adminQuestQuery(id: string) {
  return queryOptions({
    queryKey: ['admin', 'quests', id],
    queryFn: () => api.adminQuest(id),
    enabled: id.length > 0,
  })
}

export const adminGroupsQuery = queryOptions({
  queryKey: ['admin', 'groups'],
  queryFn: api.adminGroups,
  staleTime: 10_000,
})

export function adminWalletTransactionsQuery(userId: string) {
  return queryOptions({
    queryKey: ['admin', 'wallets', userId, 'transactions'],
    queryFn: () => api.adminWalletTransactions(userId),
    refetchInterval: 10_000,
    staleTime: 5_000,
    enabled: userId.length > 0,
  })
}

export const adminAuctionsQuery = queryOptions({
  queryKey: ['admin', 'auctions'],
  queryFn: api.adminAuctions,
  refetchInterval: 10_000,
  staleTime: 5_000,
})

export function adminAuctionBidsQuery(id: string) {
  return queryOptions({
    queryKey: ['admin', 'auctions', id, 'bids'],
    queryFn: () => api.adminAuctionBids(id),
    refetchInterval: 10_000,
    staleTime: 5_000,
    enabled: id.length > 0,
  })
}

export const adminBuyOffersQuery = queryOptions({
  queryKey: ['admin', 'auctions', 'offers'],
  queryFn: api.adminBuyOffers,
  refetchInterval: 10_000,
  staleTime: 5_000,
})

export function adminBackupContentsQuery(id: string) {
  return queryOptions({
    queryKey: ['admin', 'backups', id, 'contents'],
    queryFn: () => api.adminBackupContents(id),
    staleTime: 60_000,
    enabled: id.length > 0,
  })
}

export function adminBackupFileQuery(id: string, path: string) {
  return queryOptions({
    queryKey: ['admin', 'backups', id, 'file', path],
    queryFn: () => api.adminBackupFile(id, path),
    staleTime: 60_000,
    enabled: id.length > 0 && path.length > 0,
  })
}

export const languagesQuery = queryOptions({
  queryKey: ['i18n', 'languages'],
  queryFn: api.i18nLanguages,
  staleTime: 60_000,
})

export const newsQuery = queryOptions({
  queryKey: ['news'],
  queryFn: api.news,
  staleTime: 30_000,
})

export function newsPostQuery(slug: string) {
  return queryOptions({
    queryKey: ['news', slug],
    queryFn: () => api.newsPost(slug),
    enabled: slug.length > 0,
    staleTime: 30_000,
  })
}

export const adminNewsQuery = queryOptions({
  queryKey: ['admin', 'news'],
  queryFn: api.adminNews,
  staleTime: 10_000,
})

export const adminLanguagesQuery = queryOptions({
  queryKey: ['admin', 'languages'],
  queryFn: api.adminLanguages,
  staleTime: 15_000,
})

export const adminTranslationsQuery = queryOptions({
  queryKey: ['admin', 'translations'],
  queryFn: api.adminTranslations,
  staleTime: 10_000,
})

export const adminSafeZonesQuery = queryOptions({
  queryKey: ['admin', 'safe-zones'],
  queryFn: api.adminSafeZones,
  refetchInterval: 15_000,
  refetchIntervalInBackground: false,
  staleTime: 5_000,
})

export const safeZonesQuery = queryOptions({
  queryKey: ['safe-zones'],
  queryFn: api.safeZones,
  refetchInterval: 15_000,
  refetchIntervalInBackground: false,
  staleTime: 5_000,
})
