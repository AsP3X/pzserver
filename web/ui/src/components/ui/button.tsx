import type { ComponentProps } from 'react'

import { cn } from '@/lib/cn'

type Variant = 'primary' | 'outline' | 'ghost'
type Size = 'sm' | 'md'

const base =
  'inline-flex items-center justify-center gap-2 font-display uppercase tracking-wider ' +
  'transition-colors select-none active:translate-y-px ' +
  'disabled:pointer-events-none disabled:opacity-40'

const variants: Record<Variant, string> = {
  // Hazard amber on near-black: the one thing on the page that shouts.
  primary: 'bg-hazard text-void hover:bg-[#ffb42a]',
  outline:
    'border border-fence-bright text-bone hover:border-hazard hover:text-hazard bg-transparent',
  ghost: 'text-smoke hover:text-bone hover:bg-ash-raised',
}

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-xs',
  md: 'h-12 px-6 text-sm',
}

interface ButtonProps extends ComponentProps<'button'> {
  variant?: Variant
  size?: Size
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    />
  )
}

interface LinkButtonProps extends ComponentProps<'a'> {
  variant?: Variant
  size?: Size
}

/** Same visual treatment, for anchors that navigate rather than act. */
export function LinkButton({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: LinkButtonProps) {
  return (
    <a
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    />
  )
}
