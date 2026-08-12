import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { Field, FormError } from '@/components/ui/field'
import { AuthCard } from '@/routes/auth/auth-card'
import { useLogin } from '@/lib/auth'
import { useRedirectSignedIn } from '@/lib/auth-guards'
import { splitError } from '@/lib/form-error'
import { useTranslation } from '@/i18n/use-translation'

const FIELDS = ['email', 'password'] as const

export function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  useRedirectSignedIn()
  const login = useLogin()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const errors = splitError(login.error, t('auth.unexpected_error'), FIELDS)

  function submit(event: FormEvent) {
    event.preventDefault()

    login.mutate({ email, password }, { onSuccess: () => void navigate({ to: '/' }) })
  }

  return (
    <AuthCard
      eyebrow={t('auth.login_eyebrow')}
      title={t('auth.login_title')}
      description={t('auth.login_description')}
      footer={
        <>
          {t('auth.no_account')}{' '}
          <Link to="/register" className="text-hazard hover:underline">
            {t('auth.register_link')}
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
          autoComplete="current-password"
          required
          error={errors.fields.password}
        />

        <Button type="submit" disabled={login.isPending} className="mt-1 w-full">
          {login.isPending ? t('auth.signing_in') : t('auth.sign_in')}
        </Button>
      </form>
    </AuthCard>
  )
}
