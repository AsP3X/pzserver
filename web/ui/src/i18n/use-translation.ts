import { createContext, use } from 'react'

import type { Locale, TranslationKey } from '@/i18n/locales'

export type Replacements = Record<string, string | number>

export interface TranslationContextValue {
  locale: Locale
  /** BCP 47 tag for `Intl` formatters. */
  intlLocale: string
  setLocale: (locale: Locale) => void
  /** Placeholders use the `:name` syntax the rest of the project uses. */
  t: (key: TranslationKey, replacements?: Replacements) => string
}

export const TranslationContext = createContext<TranslationContextValue | null>(null)

export function useTranslation(): TranslationContextValue {
  const context = use(TranslationContext)

  if (context === null) {
    throw new Error('useTranslation must be used inside a TranslationProvider')
  }

  return context
}
