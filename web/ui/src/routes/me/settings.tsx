import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type TwoFactorEnrolment } from '@/lib/api'
import { useChangePassword, useCurrentUser } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { splitError } from '@/lib/form-error'
import { twoFactorStatusQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

const MIN_PASSWORD_LENGTH = 10

export function SettingsPage() {
  const { t } = useTranslation()
  const { user, isLoading } = useCurrentUser()

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 lg:p-5">
      <header>
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="hazard-tape h-1 w-8" />
          <span className="eyebrow">{t('account.eyebrow')}</span>
        </div>
        <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('account.title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-smoke">{t('account.description')}</p>
      </header>

      <Panel bracketed className="max-w-2xl">
        <PanelHeader label={t('account.details')} />
        <dl className="grid grid-cols-1 divide-y divide-fence sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <Detail label={t('auth.email')} value={isLoading ? undefined : user?.email} />
          <Detail
            label={t('account.linked_character')}
            value={isLoading ? undefined : user?.username}
          />
        </dl>
      </Panel>

      <div className="max-w-2xl">
        <ChangeEmailForm current={user?.email} />
      </div>

      <div className="max-w-2xl">
        <ChangePasswordForm />
      </div>

      <div className="max-w-2xl">
        <TwoFactorPanel />
      </div>
    </section>
  )
}

/**
 * Move the address on the account.
 *
 * Asks for the password: an address is recovery-adjacent — whoever holds it
 * looks like the owner to anyone reading the account — so an unattended browser
 * must not be enough to change it.
 */
function ChangeEmailForm({ current }: { current: string | undefined }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [done, setDone] = useState(false)

  const change = useMutation({
    mutationFn: () => api.changeEmail({ password, email }),
    onSuccess: (response) => {
      setDone(true)
      setPassword('')
      setEmail('')
      queryClient.setQueryData(['auth', 'me'], { user: response.user })
    },
  })

  const errors = splitError(change.error, t('auth.unexpected_error'), ['email', 'password'])

  return (
    <Panel bracketed>
      <PanelHeader label={t('account.change_email')} />
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(event) => {
          event.preventDefault()
          setDone(false)
          change.mutate()
        }}
      >
        {errors.form ? <FormError>{errors.form}</FormError> : null}
        {done ? (
          <p role="status" className="text-sm text-moss">
            {t('account.email_changed')}
          </p>
        ) : null}

        <Field
          label={t('account.new_email')}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          placeholder={current}
          error={errors.fields.email}
          required
        />
        <Field
          label={t('account.current_password')}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          error={errors.fields.password}
          required
        />

        <div>
          <Button
            type="submit"
            size="sm"
            disabled={change.isPending || !email.trim() || !password}
          >
            {change.isPending ? t('common.saving') : t('account.save_email')}
          </Button>
        </div>
      </form>
    </Panel>
  )
}

/**
 * Turning two-factor on and off.
 *
 * Three states rather than a switch: off, mid-enrolment (a secret exists but is
 * unproven), and on. The middle one is why enrolment cannot be one click —
 * someone who scans a code and then loses the phone before confirming must not
 * end up locked out of their own account.
 */
function TwoFactorPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isPending } = useQuery(twoFactorStatusQuery)

  const [enrolment, setEnrolment] = useState<TwoFactorEnrolment | null>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  function fail(cause: unknown) {
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['auth', '2fa'] })
  }

  const begin = useMutation({
    mutationFn: api.beginTwoFactor,
    onSuccess: (next) => {
      setError(null)
      setEnrolment(next)
    },
    onError: fail,
  })

  const confirm = useMutation({
    mutationFn: () => api.confirmTwoFactor(code),
    onSuccess: (result) => {
      setError(null)
      setEnrolment(null)
      setCode('')
      setRecoveryCodes(result.recovery_codes)
      refresh()
    },
    onError: fail,
  })

  const disable = useMutation({
    mutationFn: () => api.disableTwoFactor(password),
    onSuccess: () => {
      setError(null)
      setPassword('')
      setRecoveryCodes(null)
      refresh()
    },
    onError: fail,
  })

  return (
    <Panel bracketed>
      <PanelHeader
        label={t('account.two_factor')}
        action={
          <span
            className={cn(
              'font-mono text-[0.6875rem] tracking-widest uppercase',
              data?.enabled ? 'text-moss' : 'text-dust',
            )}
          >
            {t(data?.enabled ? 'common.enabled' : 'common.disabled')}
          </span>
        }
      />

      <div className="flex flex-col gap-4 p-5">
        {error ? <FormError>{error}</FormError> : null}

        {/* Shown once, right after enrolment. Losing these is the whole
            failure mode two-factor introduces, so they are not tucked away. */}
        {recoveryCodes ? (
          <div className="border border-hazard/40 bg-hazard-soft p-4">
            <p className="text-sm text-hazard">{t('account.recovery_codes_warning')}</p>
            <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-sm text-bone">
              {recoveryCodes.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => setRecoveryCodes(null)}
            >
              {t('account.recovery_codes_saved')}
            </Button>
          </div>
        ) : null}

        {isPending ? (
          <Skeleton className="h-16" />
        ) : data?.enabled ? (
          <>
            <p className="text-sm text-smoke">
              {t('account.two_factor_on', { count: data.recovery_codes_left })}
            </p>

            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                disable.mutate()
              }}
            >
              <Field
                label={t('account.current_password')}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                hint={t('account.two_factor_disable_hint')}
                required
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={disable.isPending || !password}
              >
                {t('account.two_factor_disable')}
              </Button>
            </form>
          </>
        ) : enrolment ? (
          <>
            <p className="text-sm text-smoke">{t('account.two_factor_scan')}</p>

            {/* No QR image: drawing one needs an encoder library, and the
                otpauth URI is what a QR code would encode anyway. On a phone
                this opens the authenticator directly, which is fewer steps
                than scanning; on a desktop the secret below is the fallback. */}
            <a
              href={enrolment.uri}
              className="border border-hazard/40 bg-hazard-soft px-4 py-3 text-center text-sm text-hazard hover:underline"
            >
              {t('account.two_factor_open_app')}
            </a>

            <div>
              <p className="eyebrow">{t('account.two_factor_manual')}</p>
              <p className="mt-1 font-mono text-sm break-all text-bone">{enrolment.secret}</p>
            </div>

            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                confirm.mutate()
              }}
            >
              <Field
                label={t('auth.two_factor_code')}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                inputMode="numeric"
                required
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={confirm.isPending || !code.trim()}>
                  {t('account.two_factor_confirm')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEnrolment(null)
                    setCode('')
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          </>
        ) : (
          <>
            <p className="text-sm text-smoke">{t('account.two_factor_off')}</p>
            <Button size="sm" disabled={begin.isPending} onClick={() => begin.mutate()}>
              {t('account.two_factor_enable')}
            </Button>
          </>
        )}
      </div>
    </Panel>
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
    <Panel bracketed>
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
