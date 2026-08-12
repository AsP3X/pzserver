import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/cn'
import { Skeleton } from '@/components/ui/skeleton'

interface StatTileProps {
  label: string
  value: string | undefined
  icon: LucideIcon
  className?: string
}

/**
 * One number and its label. The value is rendered in the display face at a
 * size that carries across the stat band; the icon stays deliberately quiet.
 */
export function StatTile({ label, value, icon: Icon, className }: StatTileProps) {
  return (
    <div className={cn('flex items-start gap-3 px-4 py-5', className)}>
      <Icon
        aria-hidden="true"
        className="mt-1 size-4 shrink-0 text-dust"
        strokeWidth={1.5}
      />
      <div className="min-w-0">
        {value === undefined ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <div className="display text-2xl text-bone tabular-nums sm:text-3xl">
            {value}
          </div>
        )}
        <div className="mt-1 font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
          {label}
        </div>
      </div>
    </div>
  )
}
