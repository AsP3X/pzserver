/** Locale-aware formatting for the numbers the site puts on screen. */

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(Math.round(value))
}

export function formatCoins(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(Math.round(value))
}

/** 12.4 MB — for archive sizes. */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(size)} ${units[unit]}`
}

/**
 * Deliberately not `notation: 'compact'`.
 *
 * Compact patterns are missing from some browsers' CLDR data for German, and
 * `Intl` degrades silently rather than throwing: English rendered "17.1k" while
 * German rendered "17.062" beside an ungrouped "3156,5". Grouped full numbers
 * are consistent everywhere and still fit the stat tiles.
 */

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
]

/**
 * "2 hours ago", in the viewer's language.
 *
 * Unlike compact notation, `RelativeTimeFormat` has complete CLDR data for both
 * locales, so this is safe to lean on.
 */
/** Calendar date and clock, in the viewer's language. */
export function formatDateTime(iso: string, locale: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function formatRelativeTime(iso: string, locale: string): string {
  const elapsed = (new Date(iso).getTime() - Date.now()) / 1000
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= seconds) {
      return formatter.format(Math.round(elapsed / seconds), unit)
    }
  }

  return formatter.format(Math.round(elapsed), 'second')
}

interface UptimeUnits {
  days: string
  hours: string
  minutes: string
}

/**
 * Container uptime as `3d 4h`, dropping units that would read as zero.
 *
 * Formatted here rather than in the API so the unit labels can be translated.
 */
export function formatUptime(seconds: number, units: UptimeUnits): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (days > 0) {
    return `${days}${units.days} ${hours}${units.hours}`
  }

  if (hours > 0) {
    return `${hours}${units.hours} ${minutes}${units.minutes}`
  }

  return `${minutes}${units.minutes}`
}
