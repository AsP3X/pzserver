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
import { RegisterPage } from '@/routes/auth/register'
import { PlayerReportsPage } from '@/routes/me/reports'
import { SettingsPage } from '@/routes/me/settings'
import { StatusPage } from '@/routes/status'

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

const adminSiteRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/site',
  component: AdminSitePage,
})

// ── Moved ───────────────────────────────────────────────────────────

/**
 * The first pass shipped these at the top level. They are one redirect each
 * rather than a broken bookmark.
 */
const movedRoutes = [
  { path: '/character', to: '/me/character' },
  { path: '/account', to: '/me/settings' },
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
      obituaryRoute,
      loginRoute,
      registerRoute,
    ]),
    playerLayout.addChildren([
      playerOverviewRoute,
      characterRoute,
      inventoryRoute,
      mapRoute,
      reportsRoute,
      settingsRoute,
    ]),
    adminLayout.addChildren([
      adminOverviewRoute,
      adminConfigRoute,
      adminModsRoute,
      adminConsoleRoute,
      adminLogsRoute,
      adminBridgeRoute,
      adminPlayersRoute,
      adminPlayerMapRoute,
      adminModerationRoute,
      adminReportsRoute,
      adminWhitelistRoute,
      adminSiteRoute,
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
