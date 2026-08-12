import { useCallback, useMemo, useState, type ReactNode } from 'react'

import {
  dictionaries,
  fallback,
  initialLocale,
  INTL_LOCALES,
  STORAGE_KEY,
  type Locale,
  type TranslationKey,
} from '@/i18n/locales'
import {
  TranslationContext,
  type Replacements,
} from '@/i18n/use-translation'

export function TranslationProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale)

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    window.localStorage.setItem(STORAGE_KEY, next)
    // Screen readers and font fallback both key off this.
    document.documentElement.lang = next
  }, [])

  const t = useCallback(
    (key: TranslationKey, replacements?: Replacements) => {
      const template = dictionaries[locale][key] ?? fallback[key] ?? key

      if (!replacements) {
        return template
      }

      return Object.entries(replacements).reduce(
        (text, [name, value]) => text.replaceAll(`:${name}`, String(value)),
        template,
      )
    },
    [locale],
  )

  const value = useMemo(
    () => ({ locale, intlLocale: INTL_LOCALES[locale], setLocale, t }),
    [locale, setLocale, t],
  )

  return <TranslationContext value={value}>{children}</TranslationContext>
}
