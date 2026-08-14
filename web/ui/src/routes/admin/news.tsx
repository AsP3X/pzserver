import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type NewsPatch, type NewsPost } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDateTime } from '@/lib/format'
import { adminNewsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

interface Draft {
  title: string
  excerpt: string
  body: string
  pinned: boolean
  published: boolean
}

const EMPTY: Draft = {
  title: '',
  excerpt: '',
  body: '',
  pinned: false,
  published: false,
}

function fromPost(post: NewsPost): Draft {
  return {
    title: post.title,
    excerpt: post.excerpt ?? '',
    body: post.body,
    pinned: post.pinned,
    published: post.published_at !== null,
  }
}

function toPatch(draft: Draft): NewsPatch {
  return {
    title: draft.title,
    excerpt: draft.excerpt.trim() === '' ? null : draft.excerpt,
    body: draft.body,
    pinned: draft.pinned,
    published: draft.published,
  }
}

export function AdminNewsPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const list = useQuery(adminNewsQuery)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [remove, setRemove] = useState<NewsPost | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const posts = list.data ?? []
  const current = posts.find((post) => post.id === selected) ?? null

  useEffect(() => {
    if (creating) {
      setDraft(EMPTY)
      return
    }
    if (current) {
      setDraft(fromPost(current))
    }
  }, [creating, current])

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'news'] })
    await queryClient.invalidateQueries({ queryKey: ['news'] })
  }

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  function patch<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const created = useMutation({
    mutationFn: () => api.adminCreateNews(toPatch(draft)),
    onSuccess: async (post) => {
      setCreating(false)
      setSelected(post.id)
      setNotice(t('news.saved'))
      setError(null)
      await refresh()
    },
    onError: fail,
  })

  const saved = useMutation({
    mutationFn: () => {
      if (!current) throw new Error('missing post')
      return api.adminUpdateNews(current.id, toPatch(draft))
    },
    onSuccess: async () => {
      setNotice(t('news.saved'))
      setError(null)
      await refresh()
    },
    onError: fail,
  })

  const destroyed = useMutation({
    mutationFn: (id: string) => api.adminDeleteNews(id),
    onSuccess: async () => {
      setRemove(null)
      setSelected(null)
      setCreating(false)
      setNotice(t('news.deleted'))
      setError(null)
      await refresh()
    },
    onError: fail,
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setNotice(null)
    if (creating) {
      created.mutate()
      return
    }
    saved.mutate()
  }

  const busy = created.isPending || saved.isPending
  const editing = creating || current !== null

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.community')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('news.admin_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('news.admin_description')}</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setCreating(true)
            setSelected(null)
            setError(null)
            setNotice(null)
          }}
        >
          <Plus aria-hidden="true" className="size-3.5" />
          {t('news.new_post')}
        </Button>
      </header>

      {notice ? (
        <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
        <Panel bracketed className="flex min-h-0 flex-col overflow-hidden">
          <PanelHeader label={t('news.posts')} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.isPending ? (
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : posts.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-dust">{t('news.empty')}</p>
            ) : (
              <ul>
                {posts.map((post) => {
                  const active = !creating && post.id === selected
                  return (
                    <li key={post.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setCreating(false)
                          setSelected(post.id)
                          setError(null)
                          setNotice(null)
                        }}
                        className={cn(
                          'flex w-full flex-col items-start gap-1 border-b border-fence px-4 py-3 text-left transition-colors last:border-0',
                          active ? 'bg-ash-raised' : 'hover:bg-ash-raised/60',
                        )}
                      >
                        <span className="display text-base text-bone">{post.title}</span>
                        <span className="flex flex-wrap items-center gap-2 font-mono text-[0.625rem] tracking-widest uppercase">
                          {post.pinned ? (
                            <span className="text-hazard">{t('news.pinned')}</span>
                          ) : null}
                          <span className={post.published_at ? 'text-moss' : 'text-dust'}>
                            {post.published_at ? t('news.published') : t('news.draft')}
                          </span>
                          <span className="text-dust">
                            {formatDateTime(post.updated_at, intlLocale)}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </Panel>

        <Panel bracketed className="flex min-h-0 flex-col overflow-hidden">
          <PanelHeader
            label={creating ? t('news.new_post') : current?.title ?? t('news.none_selected')}
            action={
              current && !creating ? (
                <Button size="sm" variant="ghost" onClick={() => setRemove(current)}>
                  <Trash2 aria-hidden="true" className="size-3.5" />
                  {t('common.delete')}
                </Button>
              ) : null
            }
          />
          {editing ? (
            <form className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" onSubmit={onSubmit}>
              <Field
                label={t('news.title_field')}
                value={draft.title}
                onChange={(event) => patch('title', event.target.value)}
                required
                maxLength={160}
              />
              <TextAreaField
                label={t('news.excerpt')}
                value={draft.excerpt}
                onChange={(event) => patch('excerpt', event.target.value)}
                hint={t('news.excerpt_hint')}
                maxLength={280}
                rows={3}
              />
              <TextAreaField
                label={t('news.body')}
                value={draft.body}
                onChange={(event) => patch('body', event.target.value)}
                hint={t('news.body_hint')}
                required
                rows={14}
                className="min-h-64"
              />
              {current ? (
                <p className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
                  {t('news.slug')}: {current.slug}
                </p>
              ) : null}
              <label className="flex items-center gap-2 text-sm text-bone">
                <input
                  type="checkbox"
                  checked={draft.pinned}
                  onChange={(event) => patch('pinned', event.target.checked)}
                />
                {t('news.pin')}
              </label>
              <label className="flex items-center gap-2 text-sm text-bone">
                <input
                  type="checkbox"
                  checked={draft.published}
                  onChange={(event) => patch('published', event.target.checked)}
                />
                {t('news.publish')}
              </label>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? t('common.saving') : t('common.save')}
                </Button>
                {creating ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setCreating(false)
                      setDraft(current ? fromPost(current) : EMPTY)
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                ) : null}
              </div>
            </form>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-dust">{t('news.none_selected')}</p>
          )}
        </Panel>
      </div>

      <ConfirmDialog
        open={remove !== null}
        title={t('news.delete_title')}
        description={t('news.delete_confirm', { title: remove?.title ?? '' })}
        tone="danger"
        busy={destroyed.isPending}
        onConfirm={() => {
          if (remove) destroyed.mutate(remove.id)
        }}
        onClose={() => setRemove(null)}
      />
    </section>
  )
}
