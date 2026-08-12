import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/cn'

interface PanelProps extends ComponentProps<'div'> {
  /** Draw the corner brackets that stand in for rounded corners. */
  bracketed?: boolean
}

export function Panel({ bracketed = false, className, ...props }: PanelProps) {
  return (
    <div
      className={cn(
        'border border-fence bg-ash',
        bracketed && 'bracketed',
        className,
      )}
      {...props}
    />
  )
}

interface PanelHeaderProps {
  label: string
  action?: ReactNode
  className?: string
}

/** Thin header strip: a mono label on the left, optional control on the right. */
export function PanelHeader({ label, action, className }: PanelHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-b border-fence px-4 py-2.5',
        className,
      )}
    >
      <span className="eyebrow">{label}</span>
      {action}
    </div>
  )
}
