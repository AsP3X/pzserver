import type { ReactNode } from 'react'

import { Container } from '@/components/ui/section'
import { Panel } from '@/components/ui/panel'

interface AuthCardProps {
  eyebrow: string
  title: string
  description: string
  children: ReactNode
  /** Link to the opposite action, shown under the card. */
  footer: ReactNode
}

/** Shared frame for the sign-in and registration forms. */
export function AuthCard({
  eyebrow,
  title,
  description,
  children,
  footer,
}: AuthCardProps) {
  return (
    <div className="grain relative min-h-[calc(100vh-4rem)] py-16 sm:py-24">
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.55]"
        style={{
          backgroundImage:
            'linear-gradient(var(--color-fence) 1px, transparent 1px), linear-gradient(90deg, var(--color-fence) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          maskImage: 'radial-gradient(ellipse 70% 50% at 50% 0%, #000 20%, transparent 75%)',
        }}
      />

      <Container className="relative max-w-md">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="hazard-tape h-1 w-10" />
          <span className="eyebrow">{eyebrow}</span>
        </div>

        <h1 className="display mt-4 text-4xl text-bone">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-smoke">{description}</p>

        <Panel bracketed className="mt-8 p-6">
          {children}
        </Panel>

        <p className="mt-6 text-center text-sm text-smoke">{footer}</p>
      </Container>
    </div>
  )
}
