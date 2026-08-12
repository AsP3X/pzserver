import { cn } from '@/lib/cn'

interface BarProps {
  /** 0–1. Anything outside is clamped. */
  fraction: number
  /**
   * When a full bar is the bad news — hunger, pain, panic. Without it a
   * starving character reads green, because the palette treats a high value as
   * a healthy one.
   */
  invert?: boolean
  className?: string
}

/** Thin status bar, coloured by how good the reading is. */
export function Bar({ fraction, invert = false, className }: BarProps) {
  const clamped = Math.max(0, Math.min(1, fraction))
  const goodness = invert ? 1 - clamped : clamped

  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden bg-fence', className)}
      role="presentation"
    >
      <div
        className={cn(
          'h-full transition-[width]',
          goodness >= 0.67 ? 'bg-moss' : goodness >= 0.34 ? 'bg-hazard' : 'bg-blood',
        )}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  )
}
