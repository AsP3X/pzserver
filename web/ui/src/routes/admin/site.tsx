import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError } from '@/lib/api'
import { adminSiteQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

/**
 * The public site's copy, in the source locale.
 *
 * German overrides live in the translations table and are a separate job. This
 * page edits the English that those overrides sit on top of.
 */
export function AdminSitePage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery(adminSiteQuery)
  const [draft, setDraft] = useState({
    site_name: '',
    hero_badge: '',
    hero_title: '',
    hero_subtitle: '',
    hero_description: '',
    hero_cta_label: '',
    footer_text: '',
    connect_host: '',
    connect_port: '16261',
    discord_url: '',
  })
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!data) {
      return
    }
    setDraft({
      site_name: data.site_name,
      hero_badge: data.hero_badge,
      hero_title: data.hero_title,
      hero_subtitle: data.hero_subtitle,
      hero_description: data.hero_description,
      hero_cta_label: data.hero_cta_label,
      footer_text: data.footer_text,
      connect_host: data.connect_host ?? '',
      connect_port: String(data.connect_port),
      discord_url: data.discord_url ?? '',
    })
  }, [data])

  const save = useMutation({
    mutationFn: () =>
      api.adminUpdateSite({
        ...draft,
        connect_port: Number(draft.connect_port) || 16261,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'site'] })
      await queryClient.invalidateQueries({ queryKey: ['site'] })
      setNotice(t('common.saved'))
    },
  })

  const error = save.error instanceof ApiError ? save.error.message : save.error ? t('auth.unexpected_error') : null

  function set(key: keyof typeof draft, value: string) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setNotice(null)
    save.mutate()
  }

  return (
    <Section className="py-10">
      <Container>
        <SectionHeading
          eyebrow={t('nav.group.system')}
          title={t('admin.site_title')}
          description={t('admin.site_description')}
        />

        {isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : isError ? (
          <div>
            <FormError>{t('common.error')}</FormError>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-6">
            <Panel bracketed>
              <PanelHeader label={t('admin.site_identity')} />
              <div className="grid gap-4 p-5 sm:grid-cols-2">
                <Field label={t('admin.site_name')} value={draft.site_name} onChange={(event) => set('site_name', event.target.value)} />
                <Field label={t('admin.site_badge')} value={draft.hero_badge} onChange={(event) => set('hero_badge', event.target.value)} />
                <Field label={t('admin.site_title_field')} value={draft.hero_title} onChange={(event) => set('hero_title', event.target.value)} />
                <Field label={t('admin.site_cta')} value={draft.hero_cta_label} onChange={(event) => set('hero_cta_label', event.target.value)} />
                <div className="sm:col-span-2">
                  <Field label={t('admin.site_subtitle')} value={draft.hero_subtitle} onChange={(event) => set('hero_subtitle', event.target.value)} />
                </div>
                <div className="sm:col-span-2">
                  <TextAreaField
                    label={t('admin.site_description_field')}
                    value={draft.hero_description}
                    onChange={(event) => set('hero_description', event.target.value)}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Field label={t('admin.site_footer')} value={draft.footer_text} onChange={(event) => set('footer_text', event.target.value)} />
                </div>
              </div>
            </Panel>

            <Panel bracketed>
              <PanelHeader label={t('admin.site_connect')} />
              <div className="grid gap-4 p-5 sm:grid-cols-2">
                <Field
                  label={t('status.address')}
                  value={draft.connect_host}
                  onChange={(event) => set('connect_host', event.target.value)}
                  hint={t('admin.site_connect_hint')}
                />
                <Field
                  label={t('admin.site_port')}
                  value={draft.connect_port}
                  onChange={(event) => set('connect_port', event.target.value)}
                  inputMode="numeric"
                />
                <div className="sm:col-span-2">
                  <Field
                    label={t('admin.site_discord')}
                    value={draft.discord_url}
                    onChange={(event) => set('discord_url', event.target.value)}
                  />
                </div>
              </div>
            </Panel>

            {notice ? (
              <p role="status" className="text-sm text-moss">
                {notice}
              </p>
            ) : null}
            {error ? <FormError>{error}</FormError> : null}

            <Button type="submit" disabled={save.isPending} className="self-start">
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </form>
        )}
      </Container>
    </Section>
  )
}
