import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { UserPlus } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { PlayerPickerDialog } from '@/components/ui/player-picker'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusPill } from '@/components/ui/status-pill'
import { api, ApiError, type FriendAction, type FriendCard } from '@/lib/api'
import { formatRelativeTime } from '@/lib/format'
import { myFriendsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const DONE_KEY: Record<FriendAction, TranslationKey> = {
  accept: 'me.friends_done_accept',
  decline: 'me.friends_done_decline',
  cancel: 'me.friends_done_cancel',
  unfriend: 'me.friends_done_unfriend',
  block: 'me.friends_done_block',
  unblock: 'me.friends_done_unblock',
}

type ConfirmKind = 'unfriend' | 'block' | null

/**
 * Friends: requests you sent and received, people you play with, blocks.
 *
 * The same graph is what the Knox Desk shows in game. A right-click in the
 * world files a request here; accepting on either surface is enough.
 */
export function FriendsPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery(myFriendsQuery)

  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<FriendCard | null>(null)
  const [confirm, setConfirm] = useState<ConfirmKind>(null)

  const incoming = data?.incoming ?? []
  const outgoing = data?.outgoing ?? []
  const friends = data?.friends ?? []
  const blocked = data?.blocked ?? []

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['me', 'friends'] })

  const send = useMutation({
    mutationFn: (name: string) => api.sendFriendRequest(name),
    onSuccess: async (card) => {
      setPicking(false)
      setNotice(
        card.status === 'accepted' ? t('me.friends_done_accept') : t('me.friends_sent'),
      )
      setError(null)
      await invalidate()
    },
    onError: (cause) => {
      setNotice(null)
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: FriendAction }) =>
      api.friendAction(id, action),
    onSuccess: async (_card, variables) => {
      setNotice(t(DONE_KEY[variables.action]))
      setError(null)
      setConfirm(null)
      setPending(null)
      await invalidate()
    },
    onError: (cause) => {
      setNotice(null)
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  const share = useMutation({
    mutationFn: ({ id, sharePosition }: { id: string; sharePosition: boolean }) =>
      api.setFriendShare(id, sharePosition),
    onSuccess: async () => {
      await invalidate()
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  const busy = send.isPending || act.isPending || share.isPending

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header>
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="hazard-tape h-1 w-8" />
          <span className="eyebrow">{t('me.friends_eyebrow')}</span>
        </div>
        <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('me.friends_title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-smoke">{t('me.friends_description')}</p>
      </header>

      {isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : isError ? (
        <div>
          <FormError>{t('common.error')}</FormError>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <>
          <Panel bracketed>
            <PanelHeader label={t('me.friends_add')} />
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
              <Button disabled={busy} onClick={() => setPicking(true)}>
                <UserPlus aria-hidden="true" className="size-3.5" />
                {t('me.friends_find')}
              </Button>
            </div>
            {error ? (
              <p className="px-5 pb-5 text-sm text-blood">{error}</p>
            ) : notice ? (
              <p className="px-5 pb-5 text-sm text-moss">{notice}</p>
            ) : null}
          </Panel>

          <PlayerPickerDialog
            open={picking}
            onSelect={(name) => send.mutate(name)}
            onClose={() => setPicking(false)}
          />

          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
            <FriendColumn
              title={t('me.friends_incoming')}
              empty={t('me.friends_incoming_empty')}
              count={incoming.length}
            >
              {incoming.map((card) => (
                <FriendRow key={card.id} card={card} intlLocale={intlLocale}>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => act.mutate({ id: card.id, action: 'accept' })}
                  >
                    {t('me.friends_accept')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => act.mutate({ id: card.id, action: 'decline' })}
                  >
                    {t('me.friends_decline')}
                  </Button>
                </FriendRow>
              ))}
            </FriendColumn>

            <FriendColumn
              title={t('me.friends_outgoing')}
              empty={t('me.friends_outgoing_empty')}
              count={outgoing.length}
            >
              {outgoing.map((card) => (
                <FriendRow key={card.id} card={card} intlLocale={intlLocale}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => act.mutate({ id: card.id, action: 'cancel' })}
                  >
                    {t('me.friends_cancel')}
                  </Button>
                </FriendRow>
              ))}
            </FriendColumn>
          </div>

          <Panel bracketed className="min-h-0">
            <PanelHeader
              label={t('me.friends_list')}
              action={
                <span className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
                  {t('me.friends_count', { count: friends.length })}
                </span>
              }
            />
            {friends.length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('me.friends_empty')}</p>
            ) : (
              <ul className="divide-y divide-fence">
                {friends.map((card) => (
                  <FriendRow key={card.id} card={card} intlLocale={intlLocale} showShare>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        share.mutate({ id: card.id, sharePosition: !card.share_position })
                      }
                    >
                      {card.share_position ? t('me.friends_sharing') : t('me.friends_hidden')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setPending(card)
                        setConfirm('unfriend')
                      }}
                    >
                      {t('me.friends_unfriend')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-blood hover:text-blood"
                      disabled={busy}
                      onClick={() => {
                        setPending(card)
                        setConfirm('block')
                      }}
                    >
                      {t('me.friends_block')}
                    </Button>
                  </FriendRow>
                ))}
              </ul>
            )}
          </Panel>

          {blocked.length > 0 ? (
            <Panel bracketed>
              <PanelHeader label={t('me.friends_blocked')} />
              <ul className="divide-y divide-fence">
                {blocked.map((card) => (
                  <FriendRow key={card.id} card={card} intlLocale={intlLocale}>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => act.mutate({ id: card.id, action: 'unblock' })}
                    >
                      {t('me.friends_unblock')}
                    </Button>
                  </FriendRow>
                ))}
              </ul>
            </Panel>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === 'block'
            ? t('me.friends_block_named', { name: pending?.username ?? '' })
            : t('me.friends_unfriend_named', { name: pending?.username ?? '' })
        }
        description={
          confirm === 'block' ? t('me.friends_block_confirm') : t('me.friends_unfriend_confirm')
        }
        confirmLabel={confirm === 'block' ? t('me.friends_block') : t('me.friends_unfriend')}
        tone={confirm === 'block' ? 'danger' : 'primary'}
        busy={act.isPending}
        onConfirm={() => {
          if (!pending || !confirm) {
            return
          }
          act.mutate({ id: pending.id, action: confirm })
        }}
        onClose={() => {
          setConfirm(null)
          setPending(null)
        }}
      />
    </section>
  )
}

function FriendColumn({
  title,
  empty,
  count,
  children,
}: {
  title: string
  empty: string
  count: number
  children: ReactNode
}) {
  return (
    <Panel bracketed className="min-h-0">
      <PanelHeader
        label={title}
        action={
          count > 0 ? (
            <span className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
              {count}
            </span>
          ) : null
        }
      />
      {count === 0 ? (
        <p className="p-5 text-sm text-dust">{empty}</p>
      ) : (
        <ul className="divide-y divide-fence">{children}</ul>
      )}
    </Panel>
  )
}

function FriendRow({
  card,
  intlLocale,
  showShare = false,
  children,
}: {
  card: FriendCard
  intlLocale: string
  showShare?: boolean
  children?: ReactNode
}) {
  const { t } = useTranslation()

  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/rankings/$username"
            params={{ username: card.username }}
            className="truncate font-display text-lg text-bone uppercase hover:text-hazard"
          >
            {card.username}
          </Link>
          <StatusPill
            state={card.online ? 'online' : 'offline'}
            label={card.online ? t('common.online') : t('common.offline')}
          />
        </div>
        <p className="mt-1 font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
          {showShare
            ? card.their_share_position
              ? t('me.friends_they_share')
              : t('me.friends_they_hide')
            : formatRelativeTime(card.created_at, intlLocale)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </li>
  )
}
