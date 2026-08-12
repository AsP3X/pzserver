import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/cn'

/** Page-width container. One place to change the measure. */
export function Container({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mx-auto w-full max-w-6xl px-5', className)} {...props} />
}

interface SectionProps extends ComponentProps<'section'> {
  children: ReactNode
}

export function Section({ className, children, ...props }: SectionProps) {
  return (
    <section className={cn('scroll-mt-20 py-16 sm:py-24', className)} {...props}>
      {children}
    </section>
  )
}

interface SectionHeadingProps {
  eyebrow: string
  title: string
  description?: string
  className?: string
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn('mb-10', className)}>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="hazard-tape h-1 w-8" />
        <span className="eyebrow">{eyebrow}</span>
      </div>
      <h2 className="display mt-3 text-3xl text-bone sm:text-4xl">{title}</h2>
      {description ? (
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-smoke">
          {description}
        </p>
      ) : null}
    </div>
  )
}
