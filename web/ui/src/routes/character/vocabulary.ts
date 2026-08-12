import { bodyPartKey, derivePartLabel, woundKey } from '@/lib/body'
import { useTranslation } from '@/i18n/use-translation'

/**
 * Translate names that came from the game.
 *
 * Body parts and wound kinds arrive as English strings from the mod. Known ones
 * have translations; anything the enum grew since falls back to the raw name so
 * a new part shows up as itself rather than vanishing.
 */
export function useGameVocabulary() {
  const { t } = useTranslation()

  return {
    part: (name: string) => {
      const key = bodyPartKey(name)

      return key ? t(key) : derivePartLabel(name)
    },
    wound: (kind: string) => {
      const key = woundKey(kind)

      return key ? t(key) : kind
    },
  }
}
