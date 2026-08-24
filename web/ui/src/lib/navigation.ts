/**
 * The site's information architecture, in one place.
 *
 * Three surfaces rather than one sidebar that changes shape by role:
 *
 * - the **public site**, which anyone can read
 * - the **player area** under `/me`, which is your own stuff
 * - **admin** under `/admin`, which is everyone else's stuff
 *
 * The old UI put all three in a single sidebar and filtered it by role, which
 * left a player looking at a "Menu" group wedged under four admin groups, and
 * an admin scrolling past 26 flat entries. Splitting them lets each surface
 * pick its own density and its own navigation, and it means a player never
 * sees the shape of the admin panel at all.
 *
 * Player routes live under `/me` to match the API's `/api/v1/me/*`, rather than
 * the old split between `/portal/*` and `/shop/my/*`.
 *
 * Adding a feature is one entry in one array. Groups are kept to roughly seven
 * items; past that, split the group rather than letting the list grow.
 */
import {
  Archive,
  Backpack,
  Bell,
  Car,
  Coins,
  Crosshair,
  Gauge,
  GitBranch,
  Languages,
  LayoutGrid,
  LifeBuoy,
  Link2,
  MapPin,
  Newspaper,
  Package,
  ScrollText,
  Settings,
  Shield,
  ShieldAlert,
  Skull,
  Sliders,
  Store,
  Tag,
  Terminal,
  Trophy,
  User,
  Users,
  Vault,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'

import type { TranslationKey } from '@/i18n/locales'

export interface NavItem {
  to: string
  label: TranslationKey
  icon: LucideIcon
  /** Not built yet — shown, but marked and not linked. */
  planned?: boolean
}

export interface NavGroup {
  label: TranslationKey
  items: NavItem[]
}

// ── Public site ─────────────────────────────────────────────────────

/** Top navigation. Kept short: this is a front door, not a control panel. */
export const PUBLIC_NAV: NavItem[] = [
  { to: '/status', label: 'nav.status', icon: Gauge },
  { to: '/rankings', label: 'nav.rankings', icon: Trophy },
  { to: '/news', label: 'nav.news', icon: Newspaper },
  { to: '/obituary', label: 'nav.obituary', icon: Skull },
]

// ── Player area ─────────────────────────────────────────────────────

export const PLAYER_NAV: NavGroup[] = [
  {
    label: 'nav.group.survivor',
    items: [
      { to: '/me', label: 'nav.overview', icon: LayoutGrid },
      { to: '/me/character', label: 'nav.character', icon: User },
      { to: '/me/inventory', label: 'nav.inventory', icon: Backpack },
      { to: '/me/map', label: 'nav.map', icon: MapPin },
    ],
  },
  {
    label: 'nav.group.holdings',
    items: [
      { to: '/me/wallet', label: 'nav.wallet', icon: Coins },
      { to: '/auctions', label: 'nav.auctions', icon: Tag },
      { to: '/me/vault', label: 'nav.vault', icon: Vault },
    ],
  },
  {
    label: 'nav.group.account',
    items: [
      { to: '/me/reports', label: 'nav.reports', icon: LifeBuoy },
      { to: '/me/settings', label: 'nav.settings', icon: Settings },
    ],
  },
]

// ── Admin ───────────────────────────────────────────────────────────

/**
 * Six groups instead of one list of twenty-six.
 *
 * The split is by what you are working on — the machine, the people, the
 * economy — rather than by which controller happens to own the route. Shop
 * administration in particular was six sibling entries in the old sidebar and
 * is one group here.
 */
export const ADMIN_NAV: NavGroup[] = [
  {
    label: 'nav.group.overview',
    items: [{ to: '/admin', label: 'nav.dashboard', icon: LayoutGrid }],
  },
  {
    label: 'nav.group.server',
    items: [
      { to: '/admin/config', label: 'nav.config', icon: Wrench },
      { to: '/admin/mods', label: 'nav.mods', icon: Package },
      { to: '/admin/backups', label: 'nav.backups', icon: Archive },
      { to: '/admin/automations', label: 'nav.automations', icon: Zap },
      { to: '/admin/console', label: 'nav.rcon_console', icon: Terminal },
      { to: '/admin/logs', label: 'nav.server_logs', icon: ScrollText },
      { to: '/admin/bridge', label: 'nav.bridge', icon: Link2 },
    ],
  },
  {
    label: 'nav.group.players',
    items: [
      { to: '/admin/players', label: 'nav.players', icon: Users },
      { to: '/admin/players/map', label: 'nav.player_map', icon: MapPin },
      { to: '/admin/moderation', label: 'nav.moderation', icon: Crosshair },
      { to: '/admin/whitelist', label: 'nav.whitelist', icon: Shield },
      { to: '/admin/reports', label: 'nav.reports', icon: LifeBuoy },
    ],
  },
  {
    label: 'nav.group.world',
    items: [
      { to: '/admin/safe-zones', label: 'nav.safe_zones', icon: ShieldAlert },
      { to: '/admin/vehicles', label: 'nav.vehicles', icon: Car, planned: true },
    ],
  },
  {
    label: 'nav.group.shop',
    items: [
      { to: '/admin/shop', label: 'nav.catalogue', icon: Store },
      { to: '/admin/auctions', label: 'nav.auctions', icon: Tag },
      { to: '/admin/wallets', label: 'nav.wallets', icon: Coins },
      { to: '/admin/quests', label: 'nav.flows', icon: GitBranch },
      { to: '/admin/shop/promotions', label: 'nav.promotions', icon: Tag, planned: true },
      { to: '/admin/vault', label: 'nav.vault', icon: Vault },
    ],
  },
  {
    label: 'nav.group.community',
    items: [
      { to: '/admin/news', label: 'nav.news', icon: Newspaper },
      { to: '/admin/discord', label: 'nav.discord', icon: Bell, planned: true },
    ],
  },
  {
    label: 'nav.group.system',
    items: [
      { to: '/admin/site', label: 'nav.site_settings', icon: Sliders },
      { to: '/admin/translations', label: 'nav.translations', icon: Languages },
      { to: '/admin/audit', label: 'nav.audit_log', icon: ScrollText },
    ],
  },
]

/**
 * Which nav entry owns a path, or null if none does.
 *
 * A link is a candidate when the path is at or beneath it, and the longest
 * candidate wins. Matching each link on its own instead lights up every
 * ancestor: `/admin/players` is a prefix of `/admin/players/map`, so standing
 * on the player map highlighted both it and Players.
 *
 * Longest-match covers the section roots for free — `/admin` stops claiming
 * every page beneath it — so no entry needs marking as exact, and a future
 * nested pair cannot reintroduce the bug by being added to the arrays above.
 *
 * The boundary check matters: a bare `startsWith` would let `/admin/shop` claim
 * a sibling like `/admin/shop-promotions`.
 */
export function activeNavItem(pathname: string, groups: NavGroup[]): string | null {
  let best: string | null = null

  for (const group of groups) {
    for (const item of group.items) {
      if (item.planned) {
        continue
      }
      if (pathname !== item.to && !pathname.startsWith(`${item.to}/`)) {
        continue
      }
      if (best === null || item.to.length > best.length) {
        best = item.to
      }
    }
  }

  return best
}

/** Roles allowed into `/admin`. */
export const ADMIN_ROLES = ['admin', 'super_admin', 'moderator'] as const

export function canAdminister(role: string | undefined): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role ?? '')
}
