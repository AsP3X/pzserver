import { Features } from '@/routes/landing/features'
import { Hero } from '@/routes/landing/hero'
import { StatsBand } from '@/routes/landing/stats-band'
import { StatusBand } from '@/routes/landing/status-band'
import { Survivors } from '@/routes/landing/survivors'

export function LandingPage() {
  return (
    <>
      <Hero />
      <StatsBand />
      <StatusBand />
      <Survivors />
      <Features />
    </>
  )
}
