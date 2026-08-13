import { useEffect, useRef } from 'react'

import { cn } from '@/lib/cn'
import { paintHead, type PlayerLook } from '@/lib/player-look'

export function PlayerHead({
  look,
  size = 28,
  className,
}: {
  look?: PlayerLook | null
  size?: number
  className?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = canvas.current
    const ctx = element?.getContext('2d')
    if (!element || !ctx) {
      return
    }
    paintHead(ctx, look, size)
  }, [look, size])

  return (
    <canvas
      ref={canvas}
      width={size}
      height={size}
      className={cn('shrink-0 rounded-full', className)}
      aria-hidden="true"
    />
  )
}
