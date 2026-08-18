import {
  Apple,
  Beef,
  ChefHat,
  Crosshair,
  Droplet,
  Dumbbell,
  Flame,
  Moon,
  Shield,
  Shirt,
  Swords,
  Weight,
  Wind,
  Zap,
  type LucideIcon,
} from 'lucide-react'

import { Bar } from '@/components/ui/bar'
import { conditionTone } from '@/lib/condition-tone'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { cn } from '@/lib/cn'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'
import type {
  ClothingItem,
  Encumbrance,
  Moodles,
  Recipe,
  SkillProgress,
  Weapon,
} from '@/lib/api'

// ── Moodles ─────────────────────────────────────────────────────────

interface MoodleRow {
  icon: LucideIcon
  label: TranslationKey
  value: number
  /** A full bar is bad news for everything except endurance. */
  invert: boolean
}

/**
 * Needs are 0–1. Older heartbeats wrote 0–100 stats (boredom, panic, pain)
 * raw, which painted a 2 as 200%. Anything above 1 is that older scale.
 */
function moodleFraction(value: number): number {
  const unit = value > 1 ? value / 100 : value

  return Math.max(0, Math.min(1, unit))
}

export function MoodlesPanel({ moodles }: { moodles: Moodles }) {
  const { t } = useTranslation()

  const rows: MoodleRow[] = [
    { icon: Apple, label: 'moodle.hunger', value: moodles.hunger ?? 0, invert: true },
    { icon: Droplet, label: 'moodle.thirst', value: moodles.thirst ?? 0, invert: true },
    { icon: Moon, label: 'moodle.fatigue', value: moodles.fatigue ?? 0, invert: true },
    { icon: Zap, label: 'moodle.endurance', value: moodles.endurance ?? 1, invert: false },
    { icon: Wind, label: 'moodle.stress', value: moodles.stress ?? 0, invert: true },
    { icon: Flame, label: 'moodle.panic', value: moodles.panic ?? 0, invert: true },
    { icon: Dumbbell, label: 'moodle.boredom', value: moodles.boredom ?? 0, invert: true },
    {
      icon: Wind,
      label: 'moodle.unhappiness',
      value: moodles.unhappiness ?? 0,
      invert: true,
    },
    { icon: Droplet, label: 'moodle.pain', value: moodles.pain ?? 0, invert: true },
    { icon: Droplet, label: 'moodle.wetness', value: moodles.wetness ?? 0, invert: true },
    { icon: Beef, label: 'moodle.drunk', value: moodles.drunk ?? 0, invert: true },
  ]

  const sick = (moodles.sickness ?? 0) > 0
  const foodSick = (moodles.food_sickness ?? 0) > 0

  return (
    <Panel bracketed>
      <PanelHeader label={t('moodle.title')} />

      <div className="flex flex-col gap-3 p-6">
        {sick || foodSick || moodles.has_cold ? (
          <div className="mb-1 flex flex-wrap gap-2">
            {sick ? <Affliction label={t('moodle.sick')} /> : null}
            {foodSick ? <Affliction label={t('moodle.food_sick')} /> : null}
            {moodles.has_cold ? <Affliction label={t('character.has_cold')} muted /> : null}
          </div>
        ) : null}

        {rows.map((row) => (
          <div key={row.label}>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-smoke">
                <row.icon aria-hidden="true" className="size-3.5 text-dust" strokeWidth={1.5} />
                {t(row.label)}
              </span>
              <span className="font-mono text-dust tabular-nums">
                {Math.round(moodleFraction(row.value) * 100)}%
              </span>
            </div>
            <Bar className="mt-1" fraction={moodleFraction(row.value)} invert={row.invert} />
          </div>
        ))}
      </div>
    </Panel>
  )
}

function Affliction({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <span
      className={cn(
        'border px-2 py-0.5 font-mono text-[0.625rem] tracking-wide uppercase',
        muted
          ? 'border-fence-bright bg-ash-raised text-smoke'
          : 'border-blood/40 bg-blood-soft text-blood',
      )}
    >
      {label}
    </span>
  )
}

// ── Weapon ──────────────────────────────────────────────────────────

export function WeaponPanel({ weapon }: { weapon: Weapon }) {
  const { t } = useTranslation()

  return (
    <Panel bracketed>
      <PanelHeader label={t('gear.weapon')} />

      <div className="flex flex-col gap-3 p-6">
        {weapon.name ? (
          <Row icon={Swords} label={t('gear.equipped')} value={weapon.name} />
        ) : (
          <p className="text-sm text-dust">{t('gear.unarmed')}</p>
        )}

        {weapon.condition === null ? null : (
          <div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-smoke">{t('gear.condition')}</span>
              <span className={cn('font-mono tabular-nums', conditionTone(weapon.condition))}>
                {Math.round(weapon.condition)}%
              </span>
            </div>
            <Bar className="mt-1" fraction={weapon.condition / 100} />
          </div>
        )}

        {weapon.sharpness === null ? null : (
          <Row
            icon={Crosshair}
            label={t('gear.sharpness')}
            value={`${Math.round(weapon.sharpness)}%`}
          />
        )}

        {weapon.ammo === null ? null : (
          <Row icon={Crosshair} label={t('gear.ammo')} value={String(weapon.ammo)} />
        )}

        {weapon.chamber === null ? null : (
          <Row
            icon={Crosshair}
            label={t('gear.chambered')}
            value={weapon.chamber ? t('common.yes') : t('common.no')}
          />
        )}

        {weapon.jam ? (
          <div>
            <Affliction label={t('gear.jammed')} />
          </div>
        ) : null}

        {weapon.attachments && weapon.attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {weapon.attachments.map((attachment) => (
              <span
                key={attachment}
                className="border border-fence-bright px-2 py-0.5 font-mono text-[0.625rem] tracking-wide text-smoke uppercase"
              >
                {attachment}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </Panel>
  )
}

// ── Clothing ────────────────────────────────────────────────────────

export function ClothingPanel({ items }: { items: ClothingItem[] }) {
  const { t } = useTranslation()

  if (items.length === 0) {
    return null
  }

  return (
    <Panel bracketed>
      <PanelHeader label={t('gear.clothing')} />

      <ul className="divide-y divide-fence">
        {items.map((item, index) => (
          <li key={`${item.slot}-${index}`} className="px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <Shirt aria-hidden="true" className="size-3.5 shrink-0 text-dust" strokeWidth={1.5} />
                <span className="truncate text-sm text-bone">{item.name}</span>
              </span>

              <span className={cn('shrink-0 font-mono text-xs tabular-nums', conditionTone(item.condition))}>
                {Math.round(item.condition)}%
              </span>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 pl-5.5 font-mono text-[0.6875rem] text-dust">
              <span className="tracking-wide uppercase">{item.slot}</span>

              {item.holes > 0 ? (
                <span className="text-blood">
                  {item.holes === 1
                    ? t('gear.hole_one')
                    : t('gear.holes_other', { count: item.holes })}
                </span>
              ) : null}

              {/*
                Both defences are labelled rather than left as coloured shields
                with the meaning in a tooltip: a tooltip says nothing on a touch
                screen, and nothing to a reader who cannot separate the two hues.
              */}
              <span className="flex items-center gap-1">
                <Shield aria-hidden="true" className="size-3 text-blood" strokeWidth={1.5} />
                {t('gear.bite')} {Math.round(item.bite)}%
              </span>
              <span className="flex items-center gap-1">
                <Shield aria-hidden="true" className="size-3 text-hazard" strokeWidth={1.5} />
                {t('gear.scratch')} {Math.round(item.scratch)}%
              </span>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

// ── Encumbrance ─────────────────────────────────────────────────────

export function EncumbrancePanel({
  encumbrance,
  bodyWeight,
}: {
  encumbrance: Encumbrance
  /** The character's own weight, which has no other home on the page. */
  bodyWeight?: number | null
}) {
  const { t, intlLocale } = useTranslation()

  if (encumbrance.current === null || encumbrance.capacity === null) {
    return null
  }

  const weight = (value: number) =>
    value.toLocaleString(intlLocale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

  return (
    <Panel bracketed>
      <PanelHeader label={t('gear.encumbrance')} />

      <div className="p-6">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1.5 text-smoke">
            <Weight aria-hidden="true" className="size-3.5 text-dust" strokeWidth={1.5} />
            {t('gear.carry_load')}
          </span>
          <span className="font-mono text-bone tabular-nums">
            {weight(encumbrance.current)} / {weight(encumbrance.capacity)}
          </span>
        </div>

        <Bar
          className="mt-2"
          fraction={encumbrance.capacity > 0 ? encumbrance.current / encumbrance.capacity : 0}
          invert
        />

        {bodyWeight === null || bodyWeight === undefined ? null : (
          <div className="mt-4 flex items-center justify-between border-t border-fence pt-4 text-sm">
            <span className="flex items-center gap-1.5 text-smoke">
              <Weight aria-hidden="true" className="size-3.5 text-dust" strokeWidth={1.5} />
              {t('gear.body_weight')}
            </span>
            <span className="font-mono text-bone tabular-nums">{weight(bodyWeight)} kg</span>
          </div>
        )}
      </div>
    </Panel>
  )
}

// ── Skills ──────────────────────────────────────────────────────────

/** PZ perks cap at ten. */
const MAX_LEVEL = 10

export function SkillsPanel({ skills }: { skills: Record<string, SkillProgress> }) {
  const { t } = useTranslation()

  const trained = Object.entries(skills).sort(
    ([leftName, left], [rightName, right]) =>
      right.level - left.level || leftName.localeCompare(rightName),
  )

  return (
    <Panel bracketed>
      <PanelHeader label={t('character.skills')} />

      {trained.length === 0 ? (
        <p className="p-6 text-sm text-dust">{t('character.no_skills')}</p>
      ) : (
        <ul className="divide-y divide-fence">
          {trained.map(([name, skill]) => (
            <li key={name} className="flex items-center gap-4 px-4 py-2.5">
              <span className="flex-1 truncate text-sm text-bone">{name}</span>

              {/* Ten pips: the shape of a character reads faster than digits. */}
              <span aria-hidden="true" className="flex gap-0.5">
                {Array.from({ length: MAX_LEVEL }, (_, index) => (
                  <span
                    key={index}
                    className={cn('h-3 w-1', index < skill.level ? 'bg-hazard' : 'bg-fence')}
                  />
                ))}
              </span>

              <span className="w-14 shrink-0 text-right font-mono text-xs text-dust tabular-nums">
                {skill.level}
                {/* Progress toward the next level, which the level alone hides. */}
                {skill.xp > 0 ? (
                  <span className="text-smoke"> +{Math.round(skill.xp * 100)}%</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

// ── Recipes ─────────────────────────────────────────────────────────

export function RecipesPanel({ recipes }: { recipes: Recipe[] }) {
  const { t } = useTranslation()

  if (recipes.length === 0) {
    return null
  }

  return (
    <Panel bracketed>
      <PanelHeader label={t('character.recipes')} />

      <div className="flex flex-wrap gap-1.5 p-6">
        {recipes.map((recipe, index) => (
          <span
            key={`${recipe.name}-${index}`}
            className="flex items-center gap-1.5 border border-fence-bright px-2 py-1 text-xs text-smoke"
          >
            <ChefHat aria-hidden="true" className="size-3 text-dust" strokeWidth={1.5} />
            {recipe.name}
          </span>
        ))}
      </div>
    </Panel>
  )
}

// ── Shared ──────────────────────────────────────────────────────────

function Row({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="flex items-center gap-1.5 text-smoke">
        <Icon aria-hidden="true" className="size-3.5 text-dust" strokeWidth={1.5} />
        {label}
      </span>
      <span className="truncate font-mono text-xs text-bone">{value}</span>
    </div>
  )
}
