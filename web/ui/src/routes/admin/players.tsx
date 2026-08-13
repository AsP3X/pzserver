import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, Search, Shield, UserX } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError } from '@/components/ui/field'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type AdminPlayer } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { adminPlayersQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

type Filter = 'all' | 'online' | 'offline'
type Pending =
  | { kind: 'kick'; player: AdminPlayer }
  | { kind: 'ban'; player: AdminPlayer }
  | null

/**
 * Everyone the server has seen, with the actions an operator takes on a name.
 *
 * Search and the online/offline filter stay client-side: the roster is hundreds
 * of names, not tens of thousands, and a round-trip to filter would make the
 * typeahead feel broken.
 */
export function AdminPlayersPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery(adminPlayersQuery)

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [pending, setPending] = useState<Pending>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const players = data ?? []
  const onlineCount = players.filter((player) => player.online).length

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    return (data ?? [])
      .filter((player) => {
        if (filter === 'online') return player.online
        if (filter === 'offline') return !player.online
        return true
      })
      .filter((player) => (query ? player.username.toLowerCase().includes(query) : true))
      .sort((left, right) => Number(right.online) - Number(left.online) || left.username.localeCompare(right.username))
  }, [data, search, filter])

  const act = useMutation({
    mutationFn: async () => {
      if (!pending) return
      if (pending.kind === 'kick') return api.adminKick(pending.player.username, reason || undefined)
      return api.adminBan(pending.player.username)
    },
    onSuccess: async () => {
      setPending(null)
      setReason('')
      await queryClient.invalidateQueries({ queryKey: ['admin', 'players'] })
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
      setPending(null)
    },
  })

  return (
    <Section className="py-10">
      <Container className="max-w-none">
        <SectionHeading
          eyebrow={t('nav.group.players')}
          title={t('admin.players_title')}
          description={t('admin.players_description', {
            online: onlineCount,
            total: players.length,
          })}
        />

        <Panel bracketed>
          <PanelHeader
            label={t('admin.players_roster')}
            action={
              <span className="font-mono text-[0.6875rem] text-dust">
                {t('common.live')}
              </span>
            }
          />

          <div className="flex flex-col gap-3 border-b border-fence p-4 sm:flex-row sm:items-end">
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute top-3.5 left-3 size-4 text-dust" />
              <Field
                label={t('common.search')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                autoComplete="off"
              />
            </div>
            <div className="flex gap-2" role="group" aria-label={t('admin.players_filter')}>
              {(
                [
                  ['all', 'common.all'],
                  ['online', 'common.online'],
                  ['offline', 'common.offline'],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  size="sm"
                  variant={filter === value ? 'primary' : 'outline'}
                  onClick={() => setFilter(value)}
                  aria-pressed={filter === value}
                >
                  {t(label)}
                </Button>
              ))}
            </div>
          </div>

          {error ? (
            <div className="px-4 pt-4">
              <FormError>{error}</FormError>
            </div>
          ) : null}

          {isPending ? (
            <div className="p-4">
              <Skeleton className="h-64 w-full" />
            </div>
          ) : isError ? (
            <div className="p-5">
              <FormError>{t('common.error')}</FormError>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : visible.length === 0 ? (
            <p className="p-5 text-sm text-dust">{t('common.none_found')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <caption className="sr-only">{t('admin.players_roster')}</caption>
                <thead className="border-b border-fence font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
                  <tr>
                    <th scope="col" className="px-4 py-3">{t('survivors.player')}</th>
                    <th scope="col" className="px-4 py-3">{t('survivors.kills')}</th>
                    <th scope="col" className="hidden px-4 py-3 md:table-cell">{t('survivors.hours')}</th>
                    <th scope="col" className="hidden px-4 py-3 lg:table-cell">{t('survivors.profession')}</th>
                    <th scope="col" className="px-4 py-3 text-right">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-fence">
                  {visible.map((player) => (
                    <tr key={player.username} className="text-bone">
                      <th scope="row" className="px-4 py-3 font-medium">
                        <span className="flex items-center gap-2">
                          <span
                            className={player.online ? 'bg-moss' : 'bg-dust'}
                            aria-hidden="true"
                            style={{ width: 8, height: 8, borderRadius: 999 }}
                          />
                          <span>{player.username}</span>
                          <span className="sr-only">
                            {player.online ? t('common.online') : t('common.offline')}
                          </span>
                          {player.is_dead ? (
                            <span className="font-mono text-[0.625rem] tracking-widest text-blood uppercase">
                              {t('survivors.dead')}
                            </span>
                          ) : null}
                          {player.sanction ? (
                            <span className="font-mono text-[0.625rem] tracking-widest text-hazard uppercase">
                              {player.sanction.kind === 'ban'
                                ? t('admin.players_banned')
                                : t('admin.players_suspended')}
                            </span>
                          ) : null}
                        </span>
                      </th>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        {formatNumber(player.zombie_kills, intlLocale)}
                      </td>
                      <td className="hidden px-4 py-3 font-mono tabular-nums md:table-cell">
                        {formatNumber(Math.round(player.hours_survived), intlLocale)}
                      </td>
                      <td className="hidden px-4 py-3 text-smoke lg:table-cell">
                        {player.profession ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!player.online}
                            onClick={() => {
                              setError(null)
                              setPending({ kind: 'kick', player })
                            }}
                          >
                            <UserX aria-hidden="true" className="size-3.5" />
                            <span className="sr-only sm:not-sr-only">{t('admin.action.kick')}</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setError(null)
                              setPending({ kind: 'ban', player })
                            }}
                          >
                            <Ban aria-hidden="true" className="size-3.5" />
                            <span className="sr-only sm:not-sr-only">{t('admin.action.ban')}</span>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <p className="mt-4 flex items-start gap-2 text-xs text-dust">
          <Shield aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t('admin.players_hint')}
        </p>
      </Container>

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === 'ban'
            ? t('admin.action.ban_named', { name: pending.player.username })
            : t('admin.action.kick_named', { name: pending?.player.username ?? '' })
        }
        description={
          <div className="flex flex-col gap-3">
            <p>
              {pending?.kind === 'ban'
                ? t('admin.action.ban_confirm')
                : t('admin.action.kick_confirm')}
            </p>
            {pending?.kind === 'kick' ? (
              <Field
                label={t('common.reason')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                hint={t('common.optional')}
              />
            ) : null}
          </div>
        }
        tone="danger"
        busy={act.isPending}
        onConfirm={() => act.mutate()}
        onClose={() => {
          if (!act.isPending) {
            setPending(null)
            setReason('')
          }
        }}
      />
    </Section>
  )
}
