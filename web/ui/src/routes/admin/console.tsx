import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { FormError } from '@/components/ui/field'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { api, ApiError } from '@/lib/api'
import { useTranslation } from '@/i18n/use-translation'

type Entry = { kind: 'in' | 'out' | 'err'; text: string }

/**
 * A live RCON session in the browser.
 *
 * History stays in this tab: the game does not keep a command log we can
 * reload, and pretending otherwise would make a refresh look like the last
 * command never ran.
 */
export function AdminConsolePage() {
  const { t } = useTranslation()
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<Entry[]>([])
  const [recall, setRecall] = useState<string[]>([])
  const [index, setIndex] = useState(-1)
  const output = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    output.current?.scrollTo({ top: output.current.scrollHeight })
  }, [history])

  const run = useMutation({
    mutationFn: (value: string) => api.adminConsole(value),
    onSuccess: (reply, value) => {
      setHistory((current) => [
        ...current,
        { kind: 'in', text: value },
        { kind: 'out', text: reply.output || t('common.no_output') },
      ])
    },
    onError: (cause, value) => {
      setHistory((current) => [
        ...current,
        { kind: 'in', text: value },
        {
          kind: 'err',
          text: cause instanceof ApiError ? cause.message : t('auth.unexpected_error'),
        },
      ])
    },
  })

  function submit(event?: FormEvent) {
    event?.preventDefault()
    const value = command.trim()
    if (!value || run.isPending) {
      return
    }
    setRecall((current) => [value, ...current.filter((item) => item !== value)].slice(0, 50))
    setIndex(-1)
    setCommand('')
    run.mutate(value)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowUp' && recall.length > 0) {
      event.preventDefault()
      const next = Math.min(index + 1, recall.length - 1)
      setIndex(next)
      setCommand(recall[next] ?? '')
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (index <= 0) {
        setIndex(-1)
        setCommand('')
      } else {
        const next = index - 1
        setIndex(next)
        setCommand(recall[next] ?? '')
      }
    }
  }

  return (
    <Section className="py-10">
      <Container>
        <SectionHeading
          eyebrow={t('nav.group.server')}
          title={t('admin.console_title')}
          description={t('admin.console_description')}
        />

        <Panel bracketed>
          <PanelHeader label={t('admin.console_session')} />
          <div
            ref={output}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            className="h-[24rem] overflow-y-auto bg-void px-4 py-3 font-mono text-sm"
          >
            {history.length === 0 ? (
              <p className="text-dust">{t('admin.console_empty')}</p>
            ) : (
              <ol className="space-y-2">
                {history.map((entry, offset) => (
                  <li
                    key={`${offset}-${entry.kind}`}
                    className={
                      entry.kind === 'in'
                        ? 'text-hazard'
                        : entry.kind === 'err'
                          ? 'text-blood'
                          : 'whitespace-pre-wrap text-bone'
                    }
                  >
                    {entry.kind === 'in' ? `> ${entry.text}` : entry.text}
                  </li>
                ))}
              </ol>
            )}
          </div>
          <form
            className="flex flex-col gap-3 border-t border-fence p-4 sm:flex-row sm:items-end"
            onSubmit={submit}
          >
            <div className="min-w-0 flex-1">
              <label htmlFor="rcon-command" className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                {t('admin.console_command')}
              </label>
              <input
                ref={input}
                id="rcon-command"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={onKeyDown}
                autoComplete="off"
                spellCheck={false}
                className="mt-2 h-12 w-full border border-fence-bright bg-void px-3 font-mono text-sm text-bone focus:border-hazard"
              />
            </div>
            <Button type="submit" disabled={!command.trim() || run.isPending}>
              {t('admin.console_send')}
            </Button>
          </form>
        </Panel>

        {run.error && !(run.error instanceof ApiError) ? (
          <div className="mt-4">
            <FormError>{t('auth.unexpected_error')}</FormError>
          </div>
        ) : null}

        <p className="mt-4 text-xs text-dust">{t('admin.console_hint')}</p>
      </Container>
    </Section>
  )
}
