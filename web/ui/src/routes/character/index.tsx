import { useQuery } from '@tanstack/react-query'
import { Clock, Crosshair, Hourglass, Skull } from 'lucide-react'

import { Container, Section, SectionHeading } from '@/components/ui/section'
import { LinkButton } from '@/components/ui/button'
import { BodyMap } from '@/routes/character/body-map'
import { Condition } from '@/routes/character/condition'
import {
  ClothingPanel,
  EncumbrancePanel,
  MoodlesPanel,
  RecipesPanel,
  SkillsPanel,
  WeaponPanel,
} from '@/routes/character/panels'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { StatTile } from '@/components/ui/stat-tile'
import { useRequireUser } from '@/lib/auth-guards'
import { useTranslation } from '@/i18n/use-translation'
import { formatNumber, formatRelativeTime } from '@/lib/format'
import { myCharacterQuery } from '@/lib/queries'
import type { Character, PlayerBody } from '@/lib/api'
import { cn } from '@/lib/cn'

export function CharacterPage() {
  const { t } = useTranslation()
  const { user } = useRequireUser()
  const { data, isPending } = useQuery({ ...myCharacterQuery, enabled: Boolean(user) })

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow={t('character.eyebrow')}
          title={t('character.title')}
          description={t('character.description')}
        />

        {isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : data?.character ? (
          <CharacterDetail
            character={data.character}
            online={data.online}
            body={data.body}
          />
        ) : (
          // Registered from in game, but the mod's export has not caught up yet.
          <NotSeenYet username={user?.username ?? ''} />
        )}
      </Container>
    </Section>
  )
}

function CharacterDetail({
  character,
  online,
  body,
}: {
  character: Character
  online: boolean
  body: PlayerBody | null
}) {
  const { t, intlLocale } = useTranslation()

  const skills = Object.entries(character.skills).sort(
    ([leftName, leftLevel], [rightName, rightLevel]) =>
      rightLevel - leftLevel || leftName.localeCompare(rightName),
  )
  const traits = character.traits ?? []

  return (
    <div className="flex flex-col gap-8">
      <Panel bracketed>
        <PanelHeader
          label={character.profession ?? t('character.no_profession')}
          action={
            <span
              className={cn(
                'inline-flex items-center gap-2 border px-3 py-1.5 font-mono text-xs tracking-wide uppercase',
                character.is_dead
                  ? 'border-blood/40 bg-blood-soft text-blood'
                  : online
                    ? 'border-moss/40 bg-moss-soft text-moss'
                    : 'border-fence bg-ash-raised text-dust',
              )}
            >
              {character.is_dead
                ? t('character.dead')
                : online
                  ? t('character.online_now')
                  : t('character.offline')}
            </span>
          }
        />

        <div className="p-6">
          <h3 className="display text-4xl text-bone">{character.username}</h3>
          <p className="mt-2 font-mono text-xs text-dust">
            {t('character.rank', { rank: character.rank })}
          </p>
        </div>

        <div className="grid grid-cols-2 divide-x divide-y divide-fence border-t border-fence sm:grid-cols-3 sm:divide-y-0">
          <StatTile
            label={t('stats.zombie_kills')}
            value={formatNumber(character.zombie_kills, intlLocale)}
            icon={Crosshair}
          />
          <StatTile
            label={t('stats.hours_survived')}
            value={formatNumber(character.hours_survived, intlLocale)}
            icon={Hourglass}
          />
          {/* Not the rank — that is already stated above the tiles. When the
              server last reported this character is the thing you cannot get
              anywhere else on the page. */}
          <StatTile
            label={t('character.last_seen')}
            value={formatRelativeTime(character.last_synced_at, intlLocale)}
            icon={Clock}
            className="col-span-2 sm:col-span-1"
          />
        </div>
      </Panel>

      {body?.health?.parts && Object.keys(body.health.parts).length > 0 ? (
        <BodyMap
          parts={body.health.parts}
          temperature={body.temperature?.parts}
          overall={body.health.overall}
        />
      ) : null}

      <Condition character={character} body={body} />

      <div className="grid gap-8 lg:grid-cols-2">
        {body?.moodles ? <MoodlesPanel moodles={body.moodles} /> : null}
        {body?.weapon ? <WeaponPanel weapon={body.weapon} /> : null}
        {body?.clothing ? <ClothingPanel items={body.clothing.items} /> : null}
        {body?.encumbrance ? (
          <EncumbrancePanel
            encumbrance={body.encumbrance}
            bodyWeight={body.info?.weight}
          />
        ) : null}
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        {/*
          The heartbeat's skills carry XP progress toward the next level; the
          stored ones are levels alone. Prefer the richer source when the mod
          has reported recently, and fall back to what Postgres kept.
        */}
        {body?.skills && Object.keys(body.skills).length > 0 ? (
          <SkillsPanel skills={body.skills} />
        ) : (
          <Skills skills={skills} />
        )}
        <Traits traits={traits} />
      </div>

      {body?.recipes ? <RecipesPanel recipes={body.recipes} /> : null}
    </div>
  )
}

function Skills({ skills }: { skills: Array<[string, number]> }) {
  const { t } = useTranslation()

  return (
    <Panel bracketed>
      <PanelHeader label={t('character.skills')} />

      {skills.length === 0 ? (
        <p className="p-6 text-sm text-dust">{t('character.no_skills')}</p>
      ) : (
        <ul className="divide-y divide-fence">
          {skills.map(([name, level]) => (
            <li key={name} className="flex items-center gap-4 px-4 py-2.5">
              <span className="flex-1 truncate text-sm text-bone">{name}</span>

              {/* Ten pips rather than a number: PZ perks cap at 10, and the
                  shape of a character reads faster than a column of digits. */}
              <span aria-hidden="true" className="flex gap-0.5">
                {Array.from({ length: 10 }, (_, index) => (
                  <span
                    key={index}
                    className={cn(
                      'h-3 w-1',
                      index < level ? 'bg-hazard' : 'bg-fence',
                    )}
                  />
                ))}
              </span>

              <span className="w-5 text-right font-mono text-xs text-smoke tabular-nums">
                {level}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function Traits({ traits }: { traits: Array<{ id: string; label: string }> }) {
  const { t } = useTranslation()

  return (
    <Panel bracketed>
      <PanelHeader label={t('character.traits')} />

      {traits.length === 0 ? (
        <p className="p-6 text-sm text-dust">{t('character.no_traits')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2 p-6">
          {traits.map((trait) => (
            <li
              key={trait.id}
              className="border border-fence-bright bg-ash-raised px-2.5 py-1 font-mono text-xs text-smoke"
            >
              {trait.label}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** Linked to a character the mod has not reported on yet. */
function NotSeenYet({ username }: { username: string }) {
  const { t } = useTranslation()

  return (
    <Panel bracketed className="p-10 text-center">
      <Skull aria-hidden="true" className="mx-auto size-8 text-dust" strokeWidth={1.25} />

      <h3 className="display mt-4 text-2xl text-bone">
        {t('character.never_played_title')}
      </h3>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-smoke">
        {t('character.never_played_body', { username })}
      </p>

      <LinkButton href="/#status" variant="outline" size="sm" className="mt-6">
        {t('nav.join_server')}
      </LinkButton>
    </Panel>
  )
}
