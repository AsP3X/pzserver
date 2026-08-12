/**
 * Route tree, defined in code.
 *
 * The tree lives here rather than inline in main.tsx so adding a route is a
 * one-line change, and so the router's types come from a single module.
 */
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'

import { RootLayout } from '@/components/layout/root-layout'
import { AccountPage } from '@/routes/account'
import { CharacterPage } from '@/routes/character'
import { LandingPage } from '@/routes/landing'
import { LoginPage } from '@/routes/auth/login'
import { RegisterPage } from '@/routes/auth/register'

const rootRoute = createRootRoute({ component: RootLayout })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LandingPage,
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
})

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: RegisterPage,
})

const characterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/character',
  component: CharacterPage,
})

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  component: AccountPage,
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    loginRoute,
    registerRoute,
    characterRoute,
    accountRoute,
  ]),
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
