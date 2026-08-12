import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { Field, FormError } from '@/components/ui/field'
import { AuthCard } from '@/routes/auth/auth-card'
import { useRegister } from '@/lib/auth'
import { useRedirectSignedIn } from '@/lib/auth-guards'
import { splitError } from '@/lib/form-error'
import { useTranslation } from '@/i18n/use-translation'

const FIELDS = ['code', 'email', 'password'] as const

/** Mirrors the API's floor, so the obvious case fails without a round trip. */
const MIN_PASSWORD_LENGTH = 10

/** Matches the code the API issues: six characters, no ambiguous letters. */
const CODE_LENGTH = 6

export function RegisterPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  useRedirectSignedIn()
  const register = useRegister()

  const [code, setCode] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [tooShort, setTooShort] = useState(false)

  const errors = splitError(register.error, t('auth.unexpected_error'), FIELDS)

  function submit(event: FormEvent) {
    event.preventDefault()

    if (password.length < MIN_PASSWORD_LENGTH) {
      setTooShort(true)
      return
    }

    setTooShort(false)
    register.mutate(
      { code, email, password },
      { onSuccess: () => void navigate({ to: '/character' }) },
    )
  }

  return (
    <AuthCard
      eyebrow={t('auth.register_eyebrow')}
      title={t('auth.register_title')}
      description={t('auth.register_description')}
      footer={
        <>
          {t('auth.have_account')}{' '}
          <Link to="/login" className="text-hazard hover:underline">
            {t('auth.login_link')}
          </Link>
        </>
      }
    >
      {/* Spelled out before the form: without a code from in game there is
          nothing to fill in here. */}
      <ol className="mb-6 flex flex-col gap-2 border-l-2 border-fence-bright pl-4 text-sm text-smoke">
        <li>{t('auth.step_join')}</li>
        <li>
          {t('auth.step_command')}{' '}
          <code className="font-mono text-hazard">/account register</code>
        </li>
        <li>{t('auth.step_code')}</li>
      </ol>

      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        {errors.form ? <FormError>{errors.form}</FormError> : null}

        <Field
          label={t('auth.code')}
          name="code"
          value={code}
          // Codes are issued uppercase; accepting any case and normalising here
          // saves a pointless rejection.
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={CODE_LENGTH}
          autoFocus
          required
          className="text-lg tracking-[0.3em]"
          error={errors.fields.code}
        />

        <Field
          label={t('auth.email')}
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
          error={errors.fields.email}
        />

        <Field
          label={t('auth.password')}
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          required
          hint={t('auth.password_hint', { min: MIN_PASSWORD_LENGTH })}
          error={
            tooShort
              ? t('auth.password_too_short', { min: MIN_PASSWORD_LENGTH })
              : errors.fields.password
          }
        />

        <Button type="submit" disabled={register.isPending} className="mt-1 w-full">
          {register.isPending ? t('auth.creating_account') : t('auth.create_account')}
        </Button>
      </form>
    </AuthCard>
  )
}
