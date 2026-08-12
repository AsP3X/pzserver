import { cn } from '@/lib/cn'

interface MeterProps {
  label: string
  /** 0–100. */
  value: number
  /** Text shown at the right of the label row. */
  readout: string
  className?: string
}

/**
 * A labelled bar. Colour tracks the value rather than the metric, so a health
 * bar going red needs no extra wiring at the call site.
 */
export function Meter({ label, value, readout, className }: MeterProps) {
  const clamped = Math.max(0, Math.min(100, value))

  const tone =
    clamped >= 67 ? 'bg-moss' : clamped >= 34 ? 'bg-hazard' : 'bg-blood'

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-xs text-smoke tabular-nums">{readout}</span>
      </div>

      <div
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={readout}
        className="mt-2 h-1.5 w-full bg-fence"
      >
        <div
          className={cn('h-full transition-[width] duration-500', tone)}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}
