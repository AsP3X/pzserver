import { useQuery } from '@tanstack/react-query'
import { Check, Copy, Link2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { currentUserQuery, useIssueLinkCode } from '@/lib/auth'
import { useCopy } from '@/lib/use-copy'
import { useTranslation } from '@/i18n/use-translation'

/** How often to re-check whether the claim has landed, while a code is up. */
const WATCH_INTERVAL_MS = 5000

/**
 * Shown when an account has no character yet.
 *
 * The player asks for a code here and types it into `/account register` in
 * game. While a code is on screen this polls the session, so alt-tabbing back
 * shows the linked character without a manual refresh.
 */
export function LinkPanel() {
  const { t } = useTranslation()
  const issue = useIssueLinkCode()
  const { copied, copy } = useCopy()

  const code = issue.data?.code ?? null

  // A second observer on the same query, mounted only while waiting. TanStack
  // refetches at the shortest interval any observer asks for, so this speeds
  // the session query up temporarily and leaves it alone afterwards.
  useQuery({ ...currentUserQuery, refetchInterval: code ? WATCH_INTERVAL_MS : false })

  const command = code ? `/account register ${code}` : ''

  return (
    <Panel bracketed>
      <PanelHeader label={t('link.eyebrow')} />

      <div className="p-8 text-center">
        <Link2 aria-hidden="true" className="mx-auto size-8 text-dust" strokeWidth={1.25} />

        <h3 className="display mt-4 text-2xl text-bone">{t('link.title')}</h3>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-smoke">
          {t('link.body')}
        </p>

        {code ? (
          <div className="mx-auto mt-8 max-w-md">
            <span className="eyebrow">{t('link.type_this')}</span>

            <div className="mt-3 flex items-center gap-2 border border-fence-bright bg-void p-3">
              <code className="min-w-0 flex-1 truncate text-left font-mono text-base text-hazard">
                {command}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copy(command)}
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

            <p className="mt-3 text-xs text-dust">
              {t('link.expires', { minutes: issue.data?.lifetime_minutes ?? 30 })}
            </p>
            <p className="mt-1 text-xs text-dust">{t('link.waiting')}</p>
          </div>
        ) : (
          <Button
            onClick={() => issue.mutate()}
            disabled={issue.isPending}
            className="mt-6"
          >
            {issue.isPending ? t('common.loading') : t('link.get_code')}
          </Button>
        )}

        {issue.isError ? (
          <p role="alert" className="mt-4 text-sm text-blood">
            {issue.error.message}
          </p>
        ) : null}
      </div>
    </Panel>
  )
}
