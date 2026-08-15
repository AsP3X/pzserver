/** Helpers for the body data the mod reports. */

import type { BodyPartHealth, BodyPartTemperature, PlayerBody } from '@/lib/api'
import { BODY_PART_ORDER } from '@/lib/body-sprites'
import type { TranslationKey } from '@/i18n/locales'

/**
 * PZ's `BodyPartType` names, mapped to translation keys.
 *
 * The mod reads the list off the enum at runtime, so this cannot be exhaustive
 * by construction — anything unrecognised falls back to
 * [`derivePartLabel`], which is English but at least readable.
 */
const PART_KEYS: Record<string, TranslationKey> = {
  Head: 'body.head',
  Neck: 'body.neck',
  Torso_Upper: 'body.torso_upper',
  Torso_Lower: 'body.torso_lower',
  Groin: 'body.groin',
  UpperArm_L: 'body.upper_arm_l',
  UpperArm_R: 'body.upper_arm_r',
  ForeArm_L: 'body.forearm_l',
  ForeArm_R: 'body.forearm_r',
  Hand_L: 'body.hand_l',
  Hand_R: 'body.hand_r',
  UpperLeg_L: 'body.upper_leg_l',
  UpperLeg_R: 'body.upper_leg_r',
  LowerLeg_L: 'body.lower_leg_l',
  LowerLeg_R: 'body.lower_leg_r',
  Foot_L: 'body.foot_l',
  Foot_R: 'body.foot_r',
}

/** The wound kinds `KR_Vitals` can report. */
const WOUND_KEYS: Record<string, TranslationKey> = {
  Bite: 'wound.bite',
  Scratch: 'wound.scratch',
  'Deep wound': 'wound.deep_wound',
  Cut: 'wound.cut',
  Burn: 'wound.burn',
  Fracture: 'wound.fracture',
  Infection: 'wound.infection',
}

export function bodyPartKey(name: string): TranslationKey | null {
  return PART_KEYS[name] ?? null
}

export function woundKey(kind: string): TranslationKey | null {
  return WOUND_KEYS[kind] ?? null
}

/**
 * Last resort for a part name the enum grew since this was written.
 *
 * `Hand_L` becomes "Left hand", `UpperLeg_R` becomes "Right upper leg".
 */
export function derivePartLabel(name: string): string {
  const segments = name.split('_')
  const last = segments.at(-1)

  let side = ''
  if (last === 'L' || last === 'R') {
    side = last === 'L' ? 'Left' : 'Right'
    segments.pop()
  }

  const words = segments
    // Split camel case: "ForeArm" -> "fore arm".
    .map((segment) => segment.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())
    .join(' ')

  const label = side ? `${side} ${words}` : words

  return label.charAt(0).toUpperCase() + label.slice(1)
}

export type TemperatureState = 'freezing' | 'cold' | 'normal' | 'warm' | 'overheating'

/**
 * Band a core temperature.
 *
 * Approximates where PZ starts showing its own hot/cold moodles; the game
 * exposes no thresholds, so these are read off normal body temperature rather
 * than taken from the source.
 */
export function temperatureState(core: number): TemperatureState {
  if (core < 35) {
    return 'freezing'
  }
  if (core < 36.4) {
    return 'cold'
  }
  if (core <= 37.6) {
    return 'normal'
  }
  if (core <= 38.5) {
    return 'warm'
  }

  return 'overheating'
}

export interface ColdestPart {
  part: string
  skin: number
}

/** The extremity losing the most heat — usually what needs covering. */
export function coldestPart(
  parts: Record<string, { skin: number }>,
): ColdestPart | null {
  const entries = Object.entries(parts)

  if (entries.length === 0) {
    return null
  }

  const [part, reading] = entries.reduce((coldest, entry) =>
    entry[1].skin < coldest[1].skin ? entry : coldest,
  )

  return { part, skin: reading.skin }
}

/**
 * What a character looks like before the server has ever reported one: whole,
 * unwounded, and comfortable.
 *
 * Callers must label this as a placeholder. Showing invented numbers as
 * though they were readings is the failure that made the 1.7 dashboard
 * useless — these are declared defaults, not a swallowed error.
 */
export const DEFAULT_SKIN_CELSIUS = 36.6

export function defaultBodyParts(): Record<string, BodyPartHealth> {
  return Object.fromEntries(BODY_PART_ORDER.map((part) => [part, { health: 100, wounds: [] }]))
}

export function defaultBodyTemperature(): Record<string, BodyPartTemperature> {
  return Object.fromEntries(
    BODY_PART_ORDER.map((part) => [part, { skin: DEFAULT_SKIN_CELSIUS, insulation: 0 }]),
  )
}

export interface BodyFigure {
  parts: Record<string, BodyPartHealth>
  temperature: Record<string, BodyPartTemperature>
  overall: number
  /** True when the figure is the declared default, not a reading. */
  placeholder: boolean
}

/**
 * The paper-doll the character page draws: the heartbeat when it has parts,
 * otherwise the declared unhurt body so the figure never disappears.
 */
export function resolveBodyFigure(body: PlayerBody | null | undefined): BodyFigure {
  const parts = body?.health?.parts
  if (body && parts && Object.keys(parts).length > 0) {
    return {
      parts,
      temperature: body.temperature?.parts ?? {},
      overall: body.health?.overall ?? 100,
      placeholder: false,
    }
  }

  return {
    parts: defaultBodyParts(),
    temperature: defaultBodyTemperature(),
    overall: 100,
    placeholder: true,
  }
}
