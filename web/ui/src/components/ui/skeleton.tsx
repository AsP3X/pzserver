import { cn } from '@/lib/cn'

/** Loading placeholder. Square, like everything else. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse bg-fence', className)}
    />
  )
}
