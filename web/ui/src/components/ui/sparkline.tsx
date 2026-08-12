import { useId } from 'react'

import { cn } from '@/lib/cn'

interface SparklineProps {
  values: number[]
  label: string
  className?: string
}

/**
 * Population over time, as an inline area chart.
 *
 * Hand-drawn rather than pulled from a chart library: it is two paths, and a
 * charting dependency would outweigh the whole rest of the page.
 *
 * The viewBox is stretched with `preserveAspectRatio="none"`, which would also
 * stretch the stroke — `vector-effect="non-scaling-stroke"` keeps it even.
 */
export function Sparkline({ values, label, className }: SparklineProps) {
  const gradientId = useId()

  if (values.length < 2) {
    return null
  }

  const width = 100
  const height = 30
  // A flat line at zero should sit on the floor, not fill the box, so the
  // scale always includes at least one player of headroom.
  const peak = Math.max(...values, 1)

  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width
    const y = height - (value / peak) * height

    return `${x.toFixed(2)},${y.toFixed(2)}`
  })

  const line = `M${points.join(' L')}`
  const area = `${line} L${width},${height} L0,${height} Z`

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('h-12 w-full', className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-moss)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--color-moss)" stopOpacity="0" />
        </linearGradient>
      </defs>

      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke="var(--color-moss)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
