/**
 * Locale definitions and dictionaries.
 *
 * English is the source of truth: its keys define `TranslationKey`. File
 * dictionaries cover en/de. Any other language lives as database overrides
 * and falls back to English.
 */
import de from './de.json'
import en from './en.json'

export const LOCALES = ['en', 'de'] as const
export type BuiltinLocale = (typeof LOCALES)[number]
export type Locale = string

export type TranslationKey = keyof typeof en

export const dictionaries: Record<BuiltinLocale, Partial<Record<TranslationKey, string>>> = {
  en,
  de,
}

export const fallback = en

export const LOCALE_LABELS: Record<BuiltinLocale, string> = {
  en: 'EN',
  de: 'DE',
}

/** BCP 47 tags for Intl formatting. */
export const INTL_LOCALES: Record<BuiltinLocale, string> = {
  en: 'en-GB',
  de: 'de-DE',
}

export const STORAGE_KEY = 'knox.locale'

export const TRANSLATION_KEYS = Object.keys(en) as TranslationKey[]

export function isBuiltin(locale: string): locale is BuiltinLocale {
  return (LOCALES as readonly string[]).includes(locale)
}

export function isLocale(value: string | null): value is Locale {
  return value !== null && /^[a-z]{2}(-[a-z]{2})?$/.test(value)
}

export function dictionaryFor(locale: string): Partial<Record<TranslationKey, string>> {
  return isBuiltin(locale) ? dictionaries[locale] : {}
}

export function intlFor(locale: string): string {
  return isBuiltin(locale) ? INTL_LOCALES[locale] : locale
}

export function labelFor(locale: string): string {
  return isBuiltin(locale) ? LOCALE_LABELS[locale] : locale.toUpperCase()
}

export function groupOf(key: string): string {
  const dot = key.indexOf('.')
  return dot === -1 ? key : key.slice(0, dot)
}

/** Stored choice first, then the browser's preference, then English. */
export function initialLocale(): Locale {
  if (typeof window === 'undefined') {
    return 'en'
  }

  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (isLocale(stored) && stored !== 'ka') {
    return stored
  }

  const language = window.navigator.language.toLowerCase()
  if (language.startsWith('de')) return 'de'
  return 'en'
}
