/**
 * Inventory wear as KR_Stash.wear writes it: a 0–1 fraction, or null when
 * the item does not degrade. The character heartbeat uses 0–100 instead.
 */
export function wearFraction(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** Same reading, as a whole-number percent for the label next to the bar. */
export function wearPercent(value: number): number {
  return Math.round(wearFraction(value) * 100)
}

/** Colour for a 0–100 condition reading, used on gear rather than bodies. */
export function conditionTone(value: number): string {
  if (value >= 75) {
    return 'text-moss'
  }
  if (value >= 40) {
    return 'text-hazard'
  }

  return 'text-blood'
}
