import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'

import {
  dictionaryFor,
  fallback,
  initialLocale,
  intlFor,
  isLocale,
  STORAGE_KEY,
  type Locale,
  type TranslationKey,
} from '@/i18n/locales'
import { TranslationContext, type Replacements } from '@/i18n/use-translation'
import { api } from '@/lib/api'

export function TranslationProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale)

  const overrides = useQuery({
    queryKey: ['i18n', locale],
    queryFn: () => api.i18nOverrides(locale),
    staleTime: 30_000,
    retry: false,
  })

  const setLocale = useCallback((next: Locale) => {
    if (!isLocale(next)) {
      return
    }
    setLocaleState(next)
    window.localStorage.setItem(STORAGE_KEY, next)
    document.documentElement.lang = next
  }, [])

  const t = useCallback(
    (key: TranslationKey, replacements?: Replacements) => {
      const file = dictionaryFor(locale)[key]
      const template = overrides.data?.[key] ?? file ?? fallback[key] ?? key

      if (!replacements) {
        return template
      }

      return Object.entries(replacements).reduce(
        (text, [name, value]) => text.replaceAll(`:${name}`, String(value)),
        template,
      )
    },
    [locale, overrides.data],
  )

  const value = useMemo(
    () => ({ locale, intlLocale: intlFor(locale), setLocale, t }),
    [locale, setLocale, t],
  )

  return <TranslationContext value={value}>{children}</TranslationContext>
}
