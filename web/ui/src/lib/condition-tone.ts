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
