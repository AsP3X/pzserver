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
  Activity,
  Archive,
  Backpack,
  Bell,
  Car,
  Coins,
  Crosshair,
  Gauge,
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
  ShoppingBag,
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
  { to: '/news', label: 'nav.news', icon: Newspaper, planned: true },
  { to: '/obituary', label: 'nav.obituary', icon: Skull, planned: true },
]

// ── Player area ─────────────────────────────────────────────────────

export const PLAYER_NAV: NavGroup[] = [
  {
    label: 'nav.group.survivor',
    items: [
      { to: '/me', label: 'nav.overview', icon: LayoutGrid },
      { to: '/me/character', label: 'nav.character', icon: User },
      { to: '/me/inventory', label: 'nav.inventory', icon: Backpack, planned: true },
      { to: '/me/map', label: 'nav.map', icon: MapPin, planned: true },
    ],
  },
  {
    label: 'nav.group.holdings',
    items: [
      { to: '/me/vault', label: 'nav.vault', icon: Vault, planned: true },
      { to: '/me/wallet', label: 'nav.wallet', icon: Coins, planned: true },
      { to: '/me/purchases', label: 'nav.purchases', icon: ShoppingBag, planned: true },
    ],
  },
  {
    label: 'nav.group.account',
    items: [
      { to: '/me/reports', label: 'nav.reports', icon: LifeBuoy, planned: true },
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
      { to: '/admin/config', label: 'nav.config', icon: Wrench, planned: true },
      { to: '/admin/mods', label: 'nav.mods', icon: Package, planned: true },
      { to: '/admin/backups', label: 'nav.backups', icon: Archive, planned: true },
      { to: '/admin/restarts', label: 'nav.auto_restart', icon: Activity, planned: true },
      { to: '/admin/console', label: 'nav.rcon_console', icon: Terminal, planned: true },
      { to: '/admin/logs', label: 'nav.server_logs', icon: ScrollText, planned: true },
      { to: '/admin/bridge', label: 'nav.bridge', icon: Link2, planned: true },
    ],
  },
  {
    label: 'nav.group.players',
    items: [
      { to: '/admin/players', label: 'nav.players', icon: Users, planned: true },
      { to: '/admin/players/map', label: 'nav.player_map', icon: MapPin, planned: true },
      { to: '/admin/moderation', label: 'nav.moderation', icon: Crosshair, planned: true },
      { to: '/admin/whitelist', label: 'nav.whitelist', icon: Shield, planned: true },
      { to: '/admin/reports', label: 'nav.reports', icon: LifeBuoy, planned: true },
    ],
  },
  {
    label: 'nav.group.world',
    items: [
      { to: '/admin/safe-zones', label: 'nav.safe_zones', icon: ShieldAlert, planned: true },
      { to: '/admin/vehicles', label: 'nav.vehicles', icon: Car, planned: true },
    ],
  },
  {
    label: 'nav.group.shop',
    items: [
      { to: '/admin/shop', label: 'nav.catalogue', icon: Store, planned: true },
      { to: '/admin/shop/bundles', label: 'nav.bundles', icon: Package, planned: true },
      { to: '/admin/shop/promotions', label: 'nav.promotions', icon: Tag, planned: true },
      { to: '/admin/shop/purchases', label: 'nav.purchases', icon: ShoppingBag, planned: true },
      { to: '/admin/wallets', label: 'nav.wallets', icon: Coins, planned: true },
      { to: '/admin/vault', label: 'nav.vault', icon: Vault, planned: true },
    ],
  },
  {
    label: 'nav.group.community',
    items: [
      { to: '/admin/news', label: 'nav.news', icon: Newspaper, planned: true },
      { to: '/admin/discord', label: 'nav.discord', icon: Bell, planned: true },
    ],
  },
  {
    label: 'nav.group.system',
    items: [
      { to: '/admin/site', label: 'nav.site_settings', icon: Sliders, planned: true },
      { to: '/admin/translations', label: 'nav.translations', icon: Languages, planned: true },
      { to: '/admin/audit', label: 'nav.audit_log', icon: ScrollText, planned: true },
    ],
  },
]

/** Roles allowed into `/admin`. */
export const ADMIN_ROLES = ['admin', 'super_admin', 'moderator'] as const

export function canAdminister(role: string | undefined): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role ?? '')
}
