import { Outlet } from '@tanstack/react-router'

import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { useTranslation } from '@/i18n/use-translation'

/** Chrome shared by every page: skip link, header, content slot, footer. */
export function RootLayout() {
  const { t } = useTranslation()

  return (
    <div id="top" className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-100 focus:bg-hazard focus:px-4 focus:py-2 focus:font-mono focus:text-xs focus:text-void focus:uppercase"
      >
        {t('nav.skip_to_content')}
      </a>

      <SiteHeader />

      <main id="main" className="flex-1">
        <Outlet />
      </main>

      <SiteFooter />
    </div>
  )
}
