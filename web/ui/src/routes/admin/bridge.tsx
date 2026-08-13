import { useQuery } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { FormError } from '@/components/ui/field'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import type { BridgeFileStatus } from '@/lib/api'
import { formatRelativeTime } from '@/lib/format'
import { adminBridgeQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const REASONS: Record<string, TranslationKey> = {
  'admin.bridge_reason_world_live': 'admin.bridge_reason_world_live',
  'admin.bridge_reason_world_stale': 'admin.bridge_reason_world_stale',
  'admin.bridge_reason_world_absent': 'admin.bridge_reason_world_absent',
  'admin.bridge_reason_live': 'admin.bridge_reason_live',
  'admin.bridge_reason_paused': 'admin.bridge_reason_paused',
  'admin.bridge_reason_heartbeat_stale': 'admin.bridge_reason_heartbeat_stale',
  'admin.bridge_reason_heartbeat_absent': 'admin.bridge_reason_heartbeat_absent',
  'admin.bridge_reason_event_ready': 'admin.bridge_reason_event_ready',
  'admin.bridge_reason_event_waiting': 'admin.bridge_reason_event_waiting',
}

/**
 * Whether the mod is still writing, and which silences are expected.
 *
 * Live positions and stats ride the in-game clock. On an empty server with
 * PauseEmpty they stop, which is not a broken bridge — the world file keeps
 * rewriting. Deaths and account-link files appear the first time they are
 * needed.
 */
export function AdminBridgePage() {
  const { t, intlLocale } = useTranslation()
  const { data, isPending, isError, refetch } = useQuery(adminBridgeQuery)

  return (
    <Section className="py-10">
      <Container>
        <SectionHeading
          eyebrow={t('nav.group.server')}
          title={t('admin.bridge_title')}
          description={t('admin.bridge_description')}
        />

        {isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : isError ? (
          <div>
            <FormError>{t('common.error')}</FormError>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {data?.world_paused && data.world_fresh ? (
              <p
                role="status"
                className="border border-hazard/40 bg-hazard-soft px-4 py-3 text-sm text-hazard"
              >
                {t('admin.bridge_world_paused')}
              </p>
            ) : null}

            <Panel bracketed>
              <PanelHeader
                label={t('admin.bridge_files')}
                action={
                  <span
                    className="max-w-[16rem] truncate font-mono text-[0.6875rem] text-dust"
                    title={data?.directory}
                  >
                    {data?.directory}
                  </span>
                }
              />
              <ul className="divide-y divide-fence">
                {(data?.files ?? []).map((file) => (
                  <li key={file.name} className="flex items-start justify-between gap-4 px-4 py-4">
                    <div className="min-w-0">
                      <p className="font-mono text-sm text-bone">{file.name}</p>
                      <p className="mt-1 text-xs leading-relaxed text-dust">
                        {t(REASONS[file.reason] ?? 'admin.bridge_reason_unknown')}
                      </p>
                      {file.modified_at ? (
                        <p className="mt-1 font-mono text-[0.6875rem] text-dust">
                          {formatRelativeTime(file.modified_at, intlLocale)}
                        </p>
                      ) : null}
                    </div>
                    <span
                      className={cn(
                        'shrink-0 font-mono text-[0.6875rem] tracking-widest uppercase',
                        statusTone(file.status),
                      )}
                    >
                      {t(statusLabel(file.status))}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        )}
      </Container>
    </Section>
  )
}

function statusLabel(status: BridgeFileStatus): TranslationKey {
  if (status === 'fresh') return 'admin.bridge_fresh'
  if (status === 'idle') return 'admin.bridge_idle'
  if (status === 'stale') return 'admin.bridge_stale'
  return 'admin.bridge_absent'
}

function statusTone(status: BridgeFileStatus): string {
  if (status === 'fresh') return 'text-moss'
  if (status === 'idle') return 'text-smoke'
  if (status === 'stale') return 'text-hazard'
  return 'text-dust'
}
