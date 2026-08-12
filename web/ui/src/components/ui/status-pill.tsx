import { cn } from '@/lib/cn'
import type { GameState } from '@/lib/api'

interface StatusPillProps {
  /** `undefined` while the first request is still in flight. */
  state: GameState | undefined
  label: string
  className?: string
}

const tones: Record<GameState, string> = {
  online: 'border-moss/40 bg-moss-soft text-moss',
  starting: 'border-hazard/40 bg-hazard-soft text-hazard',
  offline: 'border-blood/40 bg-blood-soft text-blood',
}

const dots: Record<GameState, string> = {
  online: 'bg-moss',
  starting: 'bg-hazard',
  offline: 'bg-blood',
}

/** Small state chip with a live dot. Pulses only while the world is loading. */
export function StatusPill({ state, label, className }: StatusPillProps) {
  const tone = state ? tones[state] : 'border-fence bg-ash-raised text-dust'
  const dot = state ? dots[state] : 'bg-dust'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 border px-3 py-1.5 font-mono text-xs tracking-wide uppercase',
        tone,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          dot,
          state === 'starting' && 'animate-pulse-slow',
        )}
      />
      {label}
    </span>
  )
}
