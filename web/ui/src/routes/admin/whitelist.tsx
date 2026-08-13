import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FormError } from '@/components/ui/field'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError } from '@/lib/api'
import { adminConfigQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

/**
 * Who may join.
 *
 * `Open=true` is the server.ini switch: anyone can create a character. Closing
 * it means only names already on the whitelist get in. Adding and removing
 * names goes through RCON because that is the list the game actually reads.
 */
export function AdminWhitelistPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery(adminConfigQuery)
  const [username, setUsername] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const openField = data?.fields.find((field) => field.key === 'Open')
  const isOpen = openField?.value.toLowerCase() !== 'false'

  const toggle = useMutation({
    mutationFn: (next: boolean) => api.adminSetOpen(next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'config'] })
      setNotice(t('admin.whitelist_saved'))
    },
  })

  const add = useMutation({
    mutationFn: () => api.adminWhitelistAdd(username.trim()),
    onSuccess: () => {
      setUsername('')
      setNotice(t('admin.whitelist_added'))
    },
  })

  const remove = useMutation({
    mutationFn: () => api.adminWhitelistRemove(username.trim()),
    onSuccess: () => {
      setUsername('')
      setNotice(t('admin.whitelist_removed'))
    },
  })

  const error =
    [toggle.error, add.error, remove.error].find(Boolean) instanceof ApiError
      ? ([toggle.error, add.error, remove.error].find(Boolean) as ApiError).message
      : [toggle.error, add.error, remove.error].find(Boolean)
        ? t('auth.unexpected_error')
        : null

  function onAdd(event: FormEvent) {
    event.preventDefault()
    setNotice(null)
    add.mutate()
  }

  return (
    <Section className="py-10">
      <Container>
        <SectionHeading
          eyebrow={t('nav.group.players')}
          title={t('admin.whitelist_title')}
          description={t('admin.whitelist_description')}
        />

        {notice ? (
          <p role="status" className="mb-6 border border-moss/40 bg-moss-soft px-3 py-2.5 text-sm text-moss">
            {notice}
          </p>
        ) : null}

        {isPending ? (
          <Skeleton className="h-48 w-full" />
        ) : isError ? (
          <div>
            <FormError>{t('common.error')}</FormError>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel bracketed>
              <PanelHeader label={t('admin.whitelist_access')} />
              <div className="flex flex-col gap-4 p-5">
                <p className="text-sm text-smoke">
                  {isOpen ? t('admin.whitelist_open_on') : t('admin.whitelist_open_off')}
                </p>
                {data?.missing ? <FormError>{t('admin.config_missing')}</FormError> : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={toggle.isPending || data?.missing}
                  onClick={() => {
                    setNotice(null)
                    toggle.mutate(!isOpen)
                  }}
                  aria-pressed={!isOpen}
                >
                  {isOpen ? t('admin.whitelist_close') : t('admin.whitelist_open')}
                </Button>
              </div>
            </Panel>

            <Panel bracketed>
              <PanelHeader label={t('admin.whitelist_names')} />
              <form className="flex flex-col gap-4 p-5" onSubmit={onAdd}>
                <Field
                  label={t('auth.username')}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  hint={t('admin.whitelist_names_hint')}
                />
                {error ? <FormError>{error}</FormError> : null}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" disabled={!username.trim() || add.isPending}>
                    {t('admin.whitelist_add')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!username.trim() || remove.isPending}
                    onClick={() => {
                      setNotice(null)
                      remove.mutate()
                    }}
                  >
                    {t('admin.whitelist_remove')}
                  </Button>
                </div>
              </form>
            </Panel>
          </div>
        )}
      </Container>
    </Section>
  )
}
