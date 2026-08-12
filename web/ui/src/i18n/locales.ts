/**
 * Locale definitions and dictionaries.
 *
 * English is the source of truth: its keys define `TranslationKey`, and every
 * other dictionary is type-checked against that list, so a missing translation
 * is a build error rather than an English word appearing on a German page.
 */
import de from './de.json'
import en from './en.json'

export const LOCALES = ['en', 'de'] as const
export type Locale = (typeof LOCALES)[number]

export type TranslationKey = keyof typeof en

export const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  en,
  de,
}

export const fallback = en

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'EN',
  de: 'DE',
}

/** BCP 47 tags for Intl formatting. */
export const INTL_LOCALES: Record<Locale, string> = {
  en: 'en-GB',
  de: 'de-DE',
}

export const STORAGE_KEY = 'knox.locale'

export function isLocale(value: string | null): value is Locale {
  return value !== null && (LOCALES as readonly string[]).includes(value)
}

/** Stored choice first, then the browser's preference, then English. */
export function initialLocale(): Locale {
  if (typeof window === 'undefined') {
    return 'en'
  }

  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (isLocale(stored)) {
    return stored
  }

  // Matches de, de-DE, de-AT, de-CH alike.
  return window.navigator.language.startsWith('de') ? 'de' : 'en'
}
