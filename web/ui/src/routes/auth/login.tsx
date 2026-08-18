import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { Field, FormError } from '@/components/ui/field'
import { AuthCard } from '@/routes/auth/auth-card'
import { useAnswerTwoFactor, useLogin } from '@/lib/auth'
import { useRedirectSignedIn } from '@/lib/auth-guards'
import { splitError } from '@/lib/form-error'
import { useTranslation } from '@/i18n/use-translation'

const FIELDS = ['username', 'password'] as const

export function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  useRedirectSignedIn()
  const login = useLogin()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  // Held in memory only, and only for the few minutes the server honours it.
  const [challenge, setChallenge] = useState<string | null>(null)

  // How a Steam sign-in comes back. `verify` means the account has two-factor
  // on and the challenge is waiting in an httpOnly cookie, so the code step
  // runs with no token of its own.
  const search = new URLSearchParams(useLocation().search)
  const steamOutcome = search.get('steam')
  const steamNeedsCode = search.get('verify') === '1'

  const errors = splitError(login.error, t('auth.unexpected_error'), FIELDS)

  function submit(event: FormEvent) {
    event.preventDefault()

    login.mutate(
      { username, password },
      {
        onSuccess: (outcome) => {
          if (outcome.status === 'two_factor_required') {
            setChallenge(outcome.challenge)
            return
          }

          void navigate({ to: '/' })
        },
      },
    )
  }

  if (challenge !== null || steamNeedsCode) {
    return (
      <TwoFactorStep
        challenge={challenge}
        onCancel={() => setChallenge(null)}
        onDone={() => void navigate({ to: '/' })}
      />
    )
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

        {steamOutcome === 'unknown' ? (
          <FormError>{t('auth.steam_unknown')}</FormError>
        ) : steamOutcome === 'failed' ? (
          <FormError>{t('auth.steam_failed')}</FormError>
        ) : null}

        {/* The in-game name, not the address. Signing up still asks for an
            email; typing one at a login box is just slower. */}
        <Field
          label={t('auth.username')}
          name="username"
          type="text"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          hint={t('auth.username_hint')}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          required
          error={errors.fields.username}
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

        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="h-px flex-1 bg-fence" />
          <span className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
            {t('auth.or')}
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-fence" />
        </div>

        {/* A plain link, not a fetch: this is a full-page OpenID redirect to
            Steam, and it must leave our origin rather than be proxied. */}
        <a
          href="/api/v1/auth/steam"
          className="flex h-12 items-center justify-center border border-fence-bright text-sm text-bone transition-colors hover:border-hazard hover:text-hazard"
        >
          {t('auth.steam_sign_in')}
        </a>
      </form>
    </AuthCard>
  )
}

/**
 * The code step, shown once a password has been accepted.
 *
 * Accepts a recovery code in the same box as a TOTP: the server tells them
 * apart by shape, and asking someone whose phone is gone to first pick the
 * right kind of code is a worse moment to add a decision.
 */
function TwoFactorStep({
  challenge,
  onCancel,
  onDone,
}: {
  /** Null on the Steam path, where the token is in an httpOnly cookie. */
  challenge: string | null
  onCancel: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const answer = useAnswerTwoFactor()

  const [code, setCode] = useState('')
  const errors = splitError(answer.error, t('auth.unexpected_error'), [])

  function submit(event: FormEvent) {
    event.preventDefault()

    answer.mutate({ challenge, code }, { onSuccess: onDone })
  }

  return (
    <AuthCard
      eyebrow={t('auth.login_eyebrow')}
      title={t('auth.two_factor_title')}
      description={t('auth.two_factor_description')}
      footer={
        <button type="button" onClick={onCancel} className="text-hazard hover:underline">
          {t('auth.two_factor_back')}
        </button>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        {errors.form ? <FormError>{errors.form}</FormError> : null}

        <Field
          label={t('auth.two_factor_code')}
          name="code"
          type="text"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          hint={t('auth.two_factor_hint')}
          // `one-time-code` lets iOS and Android offer the code from the
          // notification shade rather than making them switch apps.
          autoComplete="one-time-code"
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          required
        />

        <Button type="submit" disabled={answer.isPending || !code.trim()} className="mt-1 w-full">
          {answer.isPending ? t('auth.signing_in') : t('auth.sign_in')}
        </Button>
      </form>
    </AuthCard>
  )
}
