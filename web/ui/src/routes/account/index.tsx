import { useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { useChangePassword } from '@/lib/auth'
import { useRequireUser } from '@/lib/auth-guards'
import { splitError } from '@/lib/form-error'
import { useTranslation } from '@/i18n/use-translation'

const MIN_PASSWORD_LENGTH = 10

export function AccountPage() {
  const { t } = useTranslation()
  const { user, isLoading } = useRequireUser()

  return (
    <Section>
      <Container className="max-w-2xl">
        <SectionHeading
          eyebrow={t('account.eyebrow')}
          title={t('account.title')}
          description={t('account.description')}
        />

        <Panel bracketed>
          <PanelHeader label={t('account.details')} />
          <dl className="grid grid-cols-1 divide-y divide-fence sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <Detail label={t('auth.email')} value={isLoading ? undefined : user?.email} />
            <Detail
              label={t('account.linked_character')}
              value={isLoading ? undefined : user?.username}
            />
          </dl>
        </Panel>

        <ChangePasswordForm />
      </Container>
    </Section>
  )
}

function Detail({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="px-4 py-5">
      <dt className="eyebrow">{label}</dt>
      <dd className="display mt-2 truncate text-xl text-bone" title={value}>
        {value ?? <Skeleton className="h-6 w-32" />}
      </dd>
    </div>
  )
}

function ChangePasswordForm() {
  const { t } = useTranslation()
  const changePassword = useChangePassword()

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [tooShort, setTooShort] = useState(false)

  const errors = splitError(changePassword.error, t('auth.unexpected_error'), [])

  function submit(event: FormEvent) {
    event.preventDefault()

    if (next.length < MIN_PASSWORD_LENGTH) {
      setTooShort(true)
      return
    }

    setTooShort(false)
    changePassword.mutate(
      { current_password: current, new_password: next },
      {
        onSuccess: () => {
          setCurrent('')
          setNext('')
        },
      },
    )
  }

  return (
    <Panel bracketed className="mt-8">
      <PanelHeader label={t('account.change_password')} />

      <form onSubmit={submit} className="flex flex-col gap-5 p-6" noValidate>
        {errors.form ? <FormError>{errors.form}</FormError> : null}

        {changePassword.isSuccess ? (
          <p
            role="status"
            className="border border-moss/40 bg-moss-soft px-3 py-2.5 text-sm text-moss"
          >
            {t('account.password_changed')}
          </p>
        ) : null}

        <Field
          label={t('account.current_password')}
          name="current_password"
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          autoComplete="current-password"
          required
        />

        <Field
          label={t('account.new_password')}
          name="new_password"
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          autoComplete="new-password"
          required
          hint={t('account.change_password_hint')}
          error={
            tooShort ? t('auth.password_too_short', { min: MIN_PASSWORD_LENGTH }) : undefined
          }
        />

        <Button
          type="submit"
          disabled={changePassword.isPending}
          className="mt-1 self-start"
        >
          {changePassword.isPending ? t('common.saving') : t('account.save_password')}
        </Button>
      </form>
    </Panel>
  )
}
