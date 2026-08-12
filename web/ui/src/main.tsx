import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

// Self-hosted so the page never reaches out to a font CDN. All three ship
// latin-ext, which covers German's umlauts and eszett.
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/oswald'

import '@/styles/theme.css'

import { TranslationProvider } from '@/i18n/provider'
import { router } from '@/router'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The game server going away is an expected state, not a transient
      // failure worth hammering; one retry is enough.
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

const container = document.getElementById('root')

if (!container) {
  throw new Error('#root is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TranslationProvider>
        <RouterProvider router={router} />
      </TranslationProvider>
    </QueryClientProvider>
  </StrictMode>,
)
