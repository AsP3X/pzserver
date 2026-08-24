/**
 * Route tree, defined in code.
 *
 * Three pathless layout routes, one per surface — public, player, admin — so a
 * new page is added under the surface it belongs to and inherits its shell and
 * its guard automatically. See `lib/navigation.ts` for the shape those shells
 * take.
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router'

import { AdminLayout, PlayerLayout, PublicLayout } from '@/components/layout/layouts'
import { AdminBridgePage } from '@/routes/admin/bridge'
import { AdminConfigPage } from '@/routes/admin/config'
import { AdminConsolePage } from '@/routes/admin/console'
import { AdminLogsPage } from '@/routes/admin/logs'
import { AdminModerationPage } from '@/routes/admin/moderation'
import { AdminReportsPage } from '@/routes/admin/reports'
import { AdminModsPage } from '@/routes/admin/mods'
import { AdminOverviewPage } from '@/routes/admin/overview'
import { AdminPlayerMapPage } from '@/routes/admin/player-map'
import { AdminPlayersPage } from '@/routes/admin/players'
import { AdminSitePage } from '@/routes/admin/site'
import { AdminBackupsPage } from '@/routes/admin/backups'
import { AdminAutomationsPage } from '@/routes/admin/automations'
import { AdminWhitelistPage } from '@/routes/admin/whitelist'
import { CharacterPage } from '@/routes/character'
import { InventoryPage } from '@/routes/me/inventory'
import { MapPage } from '@/routes/me/map'
import { LandingPage } from '@/routes/landing'
import { LoginPage } from '@/routes/auth/login'
import { NotFoundPage } from '@/routes/not-found'
import { PlayerOverviewPage } from '@/routes/me/overview'
import { ObituaryPage } from '@/routes/obituary'
import { RankingsPage } from '@/routes/rankings'
import { PlayerProfilePage } from '@/routes/player-profile'
import { RegisterPage } from '@/routes/auth/register'
import { PlayerReportsPage } from '@/routes/me/reports'
import { SettingsPage } from '@/routes/me/settings'
import { WalletPage } from '@/routes/me/wallet'
import { VaultPage } from '@/routes/me/vault'
import { AdminVaultPage } from '@/routes/admin/vault'
import { AuctionsPage } from '@/routes/auctions'
import { AdminAuctionsPage } from '@/routes/admin/auctions'
import { AdminShopPage } from '@/routes/admin/shop'
import { AdminWalletsPage } from '@/routes/admin/wallets'
import { AdminAuditPage } from '@/routes/admin/audit'
import { AdminQuestsPage } from '@/routes/admin/quests'
import { AdminQuestEditorPage } from '@/routes/admin/quest-editor'
import { StatusPage } from '@/routes/status'
import { NewsPage } from '@/routes/news'
import { NewsPostPage } from '@/routes/news/post'
import { AdminNewsPage } from '@/routes/admin/news'
import { AdminTranslationsPage } from '@/routes/admin/translations'
import { AdminSafeZonesPage } from '@/routes/admin/safe-zones'

const rootRoute = createRootRoute({ component: Outlet })

// ── Public ──────────────────────────────────────────────────────────

const publicLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'public',
  component: PublicLayout,
  notFoundComponent: NotFoundPage,
})

const indexRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: '/',
  component: LandingPage,
})

const statusRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: '/status',
  component: StatusPage,
})

const rankingsRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: '/rankings',
  component: RankingsPage,
})

const playerProfileRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: '/rankings/$username',
  component: PlayerProfilePage,
})

const obituaryRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: '/obituary',
  component: ObituaryPage,
})

const loginRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: '/login',
  component: LoginPage,
})

const registerRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: '/register',
  component: RegisterPage,
})

const newsRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: '/news',
  component: NewsPage,
})

const newsPostRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: '/news/$slug',
  component: NewsPostPage,
})

// ── Player ──────────────────────────────────────────────────────────

const playerLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'player',
  component: PlayerLayout,
  notFoundComponent: NotFoundPage,
})

const playerOverviewRoute = createRoute({
  getParentRoute: () => playerLayout,
  path: '/me',
  component: PlayerOverviewPage,
})

const characterRoute = createRoute({
  getParentRoute: () => playerLayout,
  path: '/me/character',
  component: CharacterPage,
})

const inventoryRoute = createRoute({
  getParentRoute: () => playerLayout,
  path: '/me/inventory',
  component: InventoryPage,
})

const mapRoute = createRoute({
  getParentRoute: () => playerLayout,
  path: '/me/map',
  component: MapPage,
})

const walletRoute = createRoute({
  getParentRoute: () => playerLayout,
  path: '/me/wallet',
  component: WalletPage,
})

const auctionsRoute = createRoute({
  getParentRoute: () => playerLayout,
  path: '/auctions',
  component: AuctionsPage,
})

const vaultRoute = createRoute({
  getParentRoute: () => playerLayout,
  path: '/me/vault',
  component: VaultPage,
})

const reportsRoute = createRoute({
  getParentRoute: () => playerLayout,
  path: '/me/reports',
  component: PlayerReportsPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => playerLayout,
  path: '/me/settings',
  component: SettingsPage,
})

// ── Admin ───────────────────────────────────────────────────────────

const adminLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'admin',
  component: AdminLayout,
  notFoundComponent: NotFoundPage,
})

const adminOverviewRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin',
  component: AdminOverviewPage,
})

const adminConfigRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/config',
  component: AdminConfigPage,
})

const adminModsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/mods',
  component: AdminModsPage,
})

const adminBackupsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/backups',
  component: AdminBackupsPage,
})

const adminAutomationsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/automations',
  component: AdminAutomationsPage,
})

const adminConsoleRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/console',
  component: AdminConsolePage,
})

const adminLogsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/logs',
  component: AdminLogsPage,
})

const adminBridgeRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/bridge',
  component: AdminBridgePage,
})

const adminPlayersRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/players',
  component: AdminPlayersPage,
})

const adminPlayerMapRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/players/map',
  component: AdminPlayerMapPage,
})

const adminModerationRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/moderation',
  component: AdminModerationPage,
})

const adminReportsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/reports',
  component: AdminReportsPage,
})

const adminWhitelistRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/whitelist',
  component: AdminWhitelistPage,
})

const adminShopRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/shop',
  component: AdminShopPage,
})

const adminAuctionsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/auctions',
  component: AdminAuctionsPage,
})

const adminWalletsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/wallets',
  component: AdminWalletsPage,
})

const adminQuestsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/quests',
  component: AdminQuestsPage,
})

const adminQuestEditorRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/quests/$questId',
  component: AdminQuestEditorPage,
})

const adminSiteRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/site',
  component: AdminSitePage,
})

const adminAuditRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/audit',
  component: AdminAuditPage,
})

const adminVaultRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/vault',
  component: AdminVaultPage,
})

const adminNewsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/news',
  component: AdminNewsPage,
})

const adminTranslationsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/translations',
  component: AdminTranslationsPage,
})

const adminSafeZonesRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/safe-zones',
  component: AdminSafeZonesPage,
})

// ── Moved ───────────────────────────────────────────────────────────

/**
 * The first pass shipped these at the top level. They are one redirect each
 * rather than a broken bookmark.
 */
const movedRoutes = [
  { path: '/character', to: '/me/character' },
  { path: '/account', to: '/me/settings' },
  { path: '/shop', to: '/auctions' },
].map(({ path, to }) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      throw redirect({ to, replace: true })
    },
  }),
)

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    publicLayout.addChildren([
      indexRoute,
      statusRoute,
      rankingsRoute,
      playerProfileRoute,
      obituaryRoute,
      newsRoute,
      newsPostRoute,
      loginRoute,
      registerRoute,
    ]),
    playerLayout.addChildren([
      playerOverviewRoute,
      characterRoute,
      inventoryRoute,
      mapRoute,
      walletRoute,
      auctionsRoute,
      vaultRoute,
      reportsRoute,
      settingsRoute,
    ]),
    adminLayout.addChildren([
      adminOverviewRoute,
      adminConfigRoute,
      adminModsRoute,
      adminBackupsRoute,
      adminAutomationsRoute,
      adminConsoleRoute,
      adminLogsRoute,
      adminBridgeRoute,
      adminPlayersRoute,
      adminPlayerMapRoute,
      adminModerationRoute,
      adminReportsRoute,
      adminWhitelistRoute,
      adminShopRoute,
      adminAuctionsRoute,
      adminWalletsRoute,
      adminQuestsRoute,
      adminQuestEditorRoute,
      adminSiteRoute,
      adminAuditRoute,
      adminVaultRoute,
      adminNewsRoute,
      adminTranslationsRoute,
      adminSafeZonesRoute,
    ]),
    ...movedRoutes,
  ]),
  defaultPreload: 'intent',
  // Only for a miss that matched no layout at all. A miss *under* a surface
  // uses that surface's own notFoundComponent, so the shell is never drawn
  // twice.
  defaultNotFoundComponent: () => (
    <PublicLayout>
      <NotFoundPage />
    </PublicLayout>
  ),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
