import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { Field, FormError } from '@/components/ui/field'
import { AuthCard } from '@/routes/auth/auth-card'
import { useRegister } from '@/lib/auth'
import { useRedirectSignedIn } from '@/lib/auth-guards'
import { splitError } from '@/lib/form-error'
import { useTranslation } from '@/i18n/use-translation'

const FIELDS = ['email', 'password'] as const

/** Mirrors the API's floor, so the obvious case fails without a round trip. */
const MIN_PASSWORD_LENGTH = 10

export function RegisterPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  useRedirectSignedIn()
  const register = useRegister()

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
    register.mutate({ email, password }, { onSuccess: () => void navigate({ to: '/character' }) })
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
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        {errors.form ? <FormError>{errors.form}</FormError> : null}

        <Field
          label={t('auth.email')}
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          autoFocus
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

        {/* No name field: the character is attached from in game afterwards. */}
        <p className="text-xs leading-relaxed text-dust">{t('auth.name_comes_later')}</p>

        <Button type="submit" disabled={register.isPending} className="mt-1 w-full">
          {register.isPending ? t('auth.creating_account') : t('auth.create_account')}
        </Button>
      </form>
    </AuthCard>
  )
}
