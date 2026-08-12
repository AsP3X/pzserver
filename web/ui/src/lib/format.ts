/** Locale-aware formatting for the numbers the site puts on screen. */

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(Math.round(value))
}

/**
 * Deliberately not `notation: 'compact'`.
 *
 * Compact patterns are missing from some browsers' CLDR data for German, and
 * `Intl` degrades silently rather than throwing: English rendered "17.1k" while
 * German rendered "17.062" beside an ungrouped "3156,5". Grouped full numbers
 * are consistent everywhere and still fit the stat tiles.
 */

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
