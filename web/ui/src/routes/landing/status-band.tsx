import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy, Map as MapIcon, Signpost, Timer, Users } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { Sparkline } from '@/components/ui/sparkline'
import { StatusPill } from '@/components/ui/status-pill'
import { useTranslation } from '@/i18n/use-translation'
import { formatUptime } from '@/lib/format'
import { serverHistoryQuery, serverStatusQuery } from '@/lib/queries'

export function StatusBand() {
  const { t } = useTranslation()
  const { data: status, isPending } = useQuery(serverStatusQuery)
  const { data: history } = useQuery(serverHistoryQuery)

  const address = status?.connect
    ? `${status.connect.host}:${status.connect.port}`
    : null

  const stateLabel = isPending
    ? t('status.checking')
    : status
      ? t(`status.${status.state}`)
      : t('status.offline')

  const sourceLabel = status ? t(`status.source_${status.data_source}`) : ''

  return (
    <Section id="status" className="border-b border-fence">
      <Container>
        <SectionHeading
          eyebrow={t('nav.status')}
          title={t('status.title')}
          description={t('status.subtitle')}
        />

        <Panel bracketed>
          <PanelHeader
            label={sourceLabel}
            action={<StatusPill state={status?.state} label={stateLabel} />}
          />

          {status && status.state !== 'online' ? (
            <p className="border-b border-fence bg-ash-raised px-4 py-3 text-sm text-smoke">
              {status.state === 'starting'
                ? t('status.starting_note')
                : t('status.offline_note')}
            </p>
          ) : null}

          <div className="grid grid-cols-1 divide-y divide-fence sm:grid-cols-2 sm:divide-x lg:grid-cols-4 lg:divide-y-0">
            <Readout
              icon={Users}
              label={t('status.players_online')}
              value={
                status
                  ? `${status.player_count}${status.max_players ? ` / ${status.max_players}` : ''}`
                  : undefined
              }
            />
            <Readout
              icon={MapIcon}
              label={t('status.map')}
              value={status ? (status.map ?? t('common.unknown')) : undefined}
            />
            <Readout
              icon={Timer}
              label={t('status.uptime')}
              value={
                status
                  ? status.uptime_seconds === null
                    ? '—'
                    : formatUptime(status.uptime_seconds, {
                        days: t('common.days_short'),
                        hours: t('common.hours_short'),
                        minutes: t('common.minutes_short'),
                      })
                  : undefined
              }
            />
            <AddressReadout address={address} />
          </div>

          <div className="border-t border-fence px-4 py-4">
            <div className="flex items-baseline justify-between">
              <span className="eyebrow">{t('status.activity_24h')}</span>
            </div>
            {history && history.length > 1 ? (
              <Sparkline
                className="mt-3"
                values={history.map((sample) => sample.player_count)}
                label={t('status.activity_24h')}
              />
            ) : (
              <p className="mt-3 text-xs text-dust">{t('status.no_activity')}</p>
            )}
          </div>
        </Panel>
      </Container>
    </Section>
  )
}

interface ReadoutProps {
  icon: typeof Users
  label: string
  value: string | undefined
}

function Readout({ icon: Icon, label, value }: ReadoutProps) {
  return (
    <div className="px-4 py-5">
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="size-3.5 text-dust" strokeWidth={1.5} />
        <span className="eyebrow">{label}</span>
      </div>
      {value === undefined ? (
        <Skeleton className="mt-2 h-7 w-24" />
      ) : (
        <p className="display mt-2 truncate text-2xl text-bone" title={value}>
          {value}
        </p>
      )}
    </div>
  )
}

/** The connect address, with a copy button — the point of the whole page. */
function AddressReadout({ address }: { address: string | null }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) {
      return
    }

    const timer = window.setTimeout(() => setCopied(false), 2000)

    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = useCallback(async () => {
    if (!address) {
      return
    }

    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
    } catch {
      // Clipboard access can be refused (insecure origin, denied permission).
      // The address is on screen either way, so there is nothing to recover.
    }
  }, [address])

  return (
    <div className="bg-ash-raised px-4 py-5">
      {/* Same icon + eyebrow row as Readout, so all four columns line up. */}
      <div className="flex items-center gap-2">
        <Signpost aria-hidden="true" className="size-3.5 text-dust" strokeWidth={1.5} />
        <span className="eyebrow">{t('status.address')}</span>
      </div>

      {address ? (
        <div className="mt-2 flex items-start gap-2">
          {/* Wraps rather than truncates: a half-shown address is useless, and
              this is the one string a visitor actually came for. */}
          <code className="min-w-0 flex-1 font-mono text-lg break-all text-hazard">
            {address}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={copy}
            aria-label={t('status.copy')}
            className="shrink-0"
          >
            {copied ? (
              <>
                <Check aria-hidden="true" className="size-3.5" />
                {t('status.copied')}
              </>
            ) : (
              <>
                <Copy aria-hidden="true" className="size-3.5" />
                {t('status.copy')}
              </>
            )}
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-sm text-dust">{t('status.address_hidden')}</p>
      )}
    </div>
  )
}
