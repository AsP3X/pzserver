import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, Copy, FileText, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { FormError } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { fuzzyMatchWords, fuzzySlices } from '@/lib/fuzzy'
import { adminBackupFileQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

const BINARY_EXT = new Set([
  'bin',
  'db',
  'sqlite',
  'sqlite3',
  'dat',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'zip',
  'gz',
  '7z',
  'tga',
  'dds',
])

const TEXT_EXT = new Set([
  'ini',
  'lua',
  'txt',
  'json',
  'xml',
  'cfg',
  'log',
  'md',
  'csv',
  'yml',
  'yaml',
  'toml',
  'properties',
  'conf',
  'example',
])

export function isTextBackupFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) {
    return true
  }
  const ext = name.slice(dot + 1).toLowerCase()
  if (BINARY_EXT.has(ext)) {
    return false
  }
  if (TEXT_EXT.has(ext)) {
    return true
  }
  return !BINARY_EXT.has(ext)
}

export interface OpenBackupFile {
  path: string
  name: string
}

/**
 * Read-only viewer for a text file inside a backup.
 *
 * The chrome is the VS Code layout people already know — title, tabs,
 * gutter, status bar — drawn with this site's surfaces and type so it
 * still belongs on the panel.
 */
export function BackupEditorDialog({
  backupId,
  files,
  activePath,
  locale,
  onSelect,
  onCloseTab,
  onClose,
}: {
  backupId: string
  files: OpenBackupFile[]
  activePath: string | null
  locale: string
  onSelect: (path: string) => void
  onCloseTab: (path: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const open = files.length > 0 && activePath !== null
  const active = files.find((file) => file.path === activePath) ?? files[0] ?? null
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchTick, setSearchTick] = useState(0)

  useEffect(() => {
    const element = dialog.current
    if (!element) {
      return
    }
    if (open && !element.open) {
      element.showModal()
    } else if (!open && element.open) {
      element.close()
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      setSearchOpen(false)
      setSearchQuery('')
    }
  }, [open])

  useEffect(() => {
    const element = dialog.current
    if (!element || !open) {
      return
    }

    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopPropagation()
        setSearchOpen(true)
        setSearchTick((tick) => tick + 1)
      }
    }

    // Capture phase so the browser find bar never takes the shortcut.
    element.addEventListener('keydown', onKey, true)
    return () => element.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className="m-auto h-[min(88rem,calc(100vh-2rem))] w-[min(144rem,calc(100vw-2rem))] border border-fence-bright bg-ash p-0 text-bone backdrop:bg-void/80"
      onCancel={(event) => {
        event.preventDefault()
        if (searchOpen) {
          setSearchOpen(false)
          return
        }
        onClose()
      }}
      onClose={() => {
        if (open) {
          onClose()
        }
      }}
    >
      {active ? (
        <div className="flex h-full min-h-0 flex-col">
          <header className="flex shrink-0 items-center gap-3 border-b border-fence px-3 py-2">
            <span aria-hidden="true" className="hazard-tape h-1 w-6" />
            <h2 id={titleId} className="min-w-0 flex-1 truncate font-mono text-sm text-bone">
              {active.name}
            </h2>
            <span className="shrink-0 border border-fence px-1.5 py-0.5 font-mono text-[0.625rem] tracking-widest text-dust uppercase">
              {t('admin.backups_editor_readonly')}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-dust hover:text-bone"
            >
              <X aria-hidden="true" className="size-4" />
              <span className="sr-only">{t('admin.backups_editor_close')}</span>
            </button>
          </header>

          <div
            role="tablist"
            aria-label={t('admin.backups_editor')}
            className="flex shrink-0 overflow-x-auto border-b border-fence bg-void [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {files.map((file) => {
              const selected = file.path === active.path
              return (
                <div
                  key={file.path}
                  className={cn(
                    'flex min-w-0 shrink-0 items-stretch border-r border-fence',
                    selected ? 'bg-ash' : 'bg-void hover:bg-ash-raised',
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => onSelect(file.path)}
                    className={cn(
                      'flex min-w-0 items-center gap-2 px-3 py-1.5 text-left',
                      selected ? 'text-bone' : 'text-smoke',
                    )}
                  >
                    <FileText aria-hidden="true" className="size-3.5 shrink-0 text-dust" />
                    <span className="max-w-[12rem] truncate font-mono text-xs">{file.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onCloseTab(file.path)}
                    className="px-2 text-dust hover:text-bone"
                  >
                    <X aria-hidden="true" className="size-3" />
                    <span className="sr-only">{t('admin.backups_editor_close_tab', { name: file.name })}</span>
                  </button>
                </div>
              )
            })}
          </div>

          <p className="shrink-0 truncate border-b border-fence bg-void px-3 py-1 font-mono text-[0.6875rem] text-dust">
            {active.path.replaceAll('/', ' › ')}
          </p>

          <EditorBody
            backupId={backupId}
            path={active.path}
            locale={locale}
            searchOpen={searchOpen}
            searchQuery={searchQuery}
            searchTick={searchTick}
            onSearchQuery={setSearchQuery}
            onSearchOpen={setSearchOpen}
          />
        </div>
      ) : null}
    </dialog>
  )
}

const LINE_HEIGHT = 24
const MATCH_CAP = 2_000

function EditorBody({
  backupId,
  path,
  locale,
  searchOpen,
  searchQuery,
  searchTick,
  onSearchQuery,
  onSearchOpen,
}: {
  backupId: string
  path: string
  locale: string
  searchOpen: boolean
  searchQuery: string
  searchTick: number
  onSearchQuery: (value: string) => void
  onSearchOpen: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const file = useQuery(adminBackupFileQuery(backupId, path))
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [copied, setCopied] = useState(false)
  const [matchIndex, setMatchIndex] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(480)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setCursor({ line: 1, col: 1 })
    setCopied(false)
    setMatchIndex(0)
    setScrollTop(0)
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [path])

  const lines = useMemo(
    () => (file.data ? file.data.content.split(/\r\n|\n|\r/) : []),
    [file.data?.content],
  )
  const ending = file.data?.content.includes('\r\n') ? 'crlf' : 'lf'
  const gutter = String(Math.max(lines.length, 1)).length
  const searching = searchOpen && searchQuery.trim().length > 0

  const matches = useMemo(
    () => (searching ? findMatches(searchQuery, lines) : EMPTY_MATCHES),
    [lines, searchQuery, searching],
  )

  const matchByLine = useMemo(() => {
    const map = new Map<number, EditorMatch[]>()
    for (const hit of matches) {
      const list = map.get(hit.line)
      if (list) {
        list.push(hit)
      } else {
        map.set(hit.line, [hit])
      }
    }
    return map
  }, [matches])

  const current = matches[matchIndex] ?? null

  useEffect(() => {
    setMatchIndex(0)
  }, [searchQuery, path])

  useEffect(() => {
    const box = scrollRef.current
    if (!box) {
      return
    }
    const measure = () => setViewHeight(box.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [file.data])

  useEffect(() => {
    if (!current || !scrollRef.current) {
      return
    }
    const box = scrollRef.current
    const next = Math.max(0, (current.line - 1) * LINE_HEIGHT - box.clientHeight / 3)
    box.scrollTop = next
    setScrollTop(next)
    setCursor({ line: current.line, col: (current.indices[0] ?? 0) + 1 })
  }, [current?.line, current?.indices])

  const start = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - 20)
  const visible = Math.ceil(viewHeight / LINE_HEIGHT) + 40
  const end = Math.min(lines.length, start + visible)

  function step(delta: number) {
    if (matches.length === 0) {
      return
    }
    setMatchIndex((index) => (index + delta + matches.length) % matches.length)
  }

  useEffect(() => {
    if (!searchOpen) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'F3') {
        return
      }
      event.preventDefault()
      if (event.shiftKey) {
        step(-1)
      } else {
        step(1)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [searchOpen, matches.length])

  async function copy() {
    if (!file.data) {
      return
    }
    try {
      await navigator.clipboard.writeText(file.data.content)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (file.isPending) {
    return <Skeleton className="m-4 min-h-0 flex-1" />
  }

  if (file.isError || !file.data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col justify-center p-5">
        <FormError>{file.error instanceof ApiError ? file.error.message : t('common.error')}</FormError>
        <Button size="sm" variant="outline" className="mt-3 self-start" onClick={() => void file.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {searchOpen ? (
        <FindWidget
          query={searchQuery}
          searchTick={searchTick}
          matchIndex={matchIndex}
          matchCount={matches.length}
          onQuery={onSearchQuery}
          onNext={() => step(1)}
          onPrev={() => step(-1)}
          onClose={() => onSearchOpen(false)}
        />
      ) : null}

      {file.data.truncated ? (
        <p role="status" className="shrink-0 border-b border-hazard/40 bg-hazard-soft px-3 py-2 text-sm text-hazard">
          {t('admin.backups_editor_truncated', {
            shown: formatBytes(file.data.content.length, locale),
            total: formatBytes(file.data.size_bytes, locale),
          })}
        </p>
      ) : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto bg-void"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div
          className="relative"
          style={{ height: Math.max(LINE_HEIGHT, lines.length * LINE_HEIGHT) }}
        >
          <div className="absolute right-0 left-0" style={{ top: start * LINE_HEIGHT }}>
            {lines.slice(start, end).map((line, offset) => {
              const lineNumber = start + offset + 1
              const lineHits = matchByLine.get(lineNumber)
              const activeHit = current?.line === lineNumber ? current : null
              return (
                <div
                  key={lineNumber}
                  className={cn(
                    'flex font-mono text-xs leading-6',
                    activeHit
                      ? 'bg-hazard-soft'
                      : lineHits
                        ? 'bg-hazard-soft/30'
                        : cursor.line === lineNumber
                          ? 'bg-ash-raised'
                          : null,
                  )}
                  style={{ height: LINE_HEIGHT }}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'sticky left-0 w-14 shrink-0 border-r border-fence bg-ash pr-2 text-right text-dust select-none',
                      activeHit ? 'text-hazard' : null,
                    )}
                  >
                    {String(lineNumber).padStart(gutter, ' ')}
                  </span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 px-3 text-left whitespace-pre text-bone"
                    onClick={() => setCursor({ line: lineNumber, col: 1 })}
                  >
                    {line.length === 0
                      ? ' '
                      : lineHits
                        ? renderHits(line, lineHits, activeHit)
                        : highlightLine(line, file.data.language)}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-fence bg-ash px-3 py-1.5 font-mono text-[0.6875rem] text-dust">
        <span>{t('admin.backups_editor_line_col', { line: cursor.line, col: cursor.col })}</span>
        <span>{t('admin.backups_editor_utf8')}</span>
        <span>{ending === 'crlf' ? t('admin.backups_editor_crlf') : t('admin.backups_editor_lf')}</span>
        <span className="uppercase">{file.data.language}</span>
        <span>{formatBytes(file.data.size_bytes, locale)}</span>
        <span className="ml-auto flex items-center gap-2">
          {copied ? <span className="text-moss">{t('admin.backups_editor_copied')}</span> : null}
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1 text-smoke hover:text-bone"
          >
            <Copy aria-hidden="true" className="size-3" />
            {t('admin.backups_editor_copy')}
          </button>
        </span>
      </footer>
    </div>
  )
}

function FindWidget({
  query,
  searchTick,
  matchIndex,
  matchCount,
  onQuery,
  onNext,
  onPrev,
  onClose,
}: {
  query: string
  searchTick: number
  matchIndex: number
  matchCount: number
  onQuery: (value: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [searchTick])

  return (
    <div className="absolute top-2 right-2 z-10 flex items-center gap-1 border border-fence-bright bg-ash py-1 pr-1 pl-2 shadow-[0_8px_24px_rgb(0_0_0/0.45)]">
      <Search aria-hidden="true" className="size-3.5 shrink-0 text-dust" />
      <input
        ref={input}
        type="text"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) {
              onPrev()
            } else {
              onNext()
            }
          }
          if (event.key === 'F3') {
            event.preventDefault()
            if (event.shiftKey) {
              onPrev()
            } else {
              onNext()
            }
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }}
        placeholder={t('admin.backups_editor_search')}
        aria-label={t('admin.backups_editor_search')}
        autoComplete="off"
        spellCheck={false}
        className="h-8 w-52 border-0 bg-transparent font-mono text-sm text-bone placeholder:text-dust focus:outline-none"
      />
      <span className="min-w-20 px-1 text-center font-mono text-[0.6875rem] text-dust tabular-nums">
        {query.trim()
          ? matchCount === 0
            ? t('admin.backups_editor_search_none')
            : t('admin.backups_editor_search_count', {
                current: matchIndex + 1,
                total: matchCount,
              })
          : null}
      </span>
      <button
        type="button"
        onClick={onPrev}
        disabled={matchCount === 0}
        className="p-1 text-dust hover:text-bone disabled:opacity-40"
      >
        <ChevronUp aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{t('admin.backups_editor_search_prev')}</span>
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        className="p-1 text-dust hover:text-bone disabled:opacity-40"
      >
        <ChevronDown aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{t('admin.backups_editor_search_next')}</span>
      </button>
      <button type="button" onClick={onClose} className="p-1 text-dust hover:text-bone">
        <X aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{t('admin.backups_editor_search_close')}</span>
      </button>
    </div>
  )
}

interface EditorMatch {
  line: number
  indices: number[]
  score: number
}

const EMPTY_MATCHES: EditorMatch[] = []

/** Word-aware fuzzy match. Spaces separate tokens; they need not appear in the line. */
function findMatches(query: string, lines: string[]): EditorMatch[] {
  const needle = query.trim()
  if (needle.length === 0) {
    return EMPTY_MATCHES
  }

  const hits: EditorMatch[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const hit = fuzzyMatchWords(needle, lines[index] ?? '')
    if (!hit || hit.indices.length === 0) {
      continue
    }
    hits.push({ line: index + 1, indices: hit.indices, score: hit.score })
    if (hits.length >= MATCH_CAP) {
      break
    }
  }

  return hits
}

function renderHits(line: string, hits: EditorMatch[], active: EditorMatch | null): ReactNode {
  const marked = hits.flatMap((hit) => hit.indices)
  const current = new Set(active?.indices ?? [])
  let cursor = 0

  return fuzzySlices(line, marked).map((slice, offset) => {
    const from = cursor
    cursor += slice.text.length
    const isCurrent = slice.match && current.has(from)
    return (
      <span
        key={offset}
        className={
          slice.match
            ? isCurrent
              ? 'bg-hazard font-semibold text-void'
              : 'bg-hazard-soft font-semibold text-hazard'
            : undefined
        }
      >
        {slice.text}
      </span>
    )
  })
}

const LUA_WORDS = new Set([
  'and',
  'break',
  'do',
  'else',
  'elseif',
  'end',
  'false',
  'for',
  'function',
  'goto',
  'if',
  'in',
  'local',
  'nil',
  'not',
  'or',
  'repeat',
  'return',
  'then',
  'true',
  'until',
  'while',
])

function highlightLine(line: string, language: string): ReactNode {
  if (language === 'ini') {
    if (/^\s*[#;]/.test(line)) {
      return <span className="text-dust">{line}</span>
    }
    if (/^\s*\[.*]\s*$/.test(line)) {
      return <span className="text-hazard">{line}</span>
    }
    const eq = line.indexOf('=')
    if (eq > 0) {
      return (
        <>
          <span className="text-moss">{line.slice(0, eq)}</span>
          <span className="text-dust">=</span>
          <span>{line.slice(eq + 1)}</span>
        </>
      )
    }
  }

  if (language === 'lua') {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('--')) {
      return <span className="text-dust">{line}</span>
    }
    return colorWords(line, LUA_WORDS)
  }

  if (language === 'json') {
    return colorJson(line)
  }

  if (language === 'xml' && /^\s*<!--/.test(line)) {
    return <span className="text-dust">{line}</span>
  }

  return line
}

function colorWords(line: string, words: Set<string>): ReactNode {
  const parts = line.split(/(\b)/)
  return parts.map((part, index) =>
    words.has(part) ? (
      <span key={index} className="text-hazard">
        {part}
      </span>
    ) : (
      <span key={index}>{part}</span>
    ),
  )
}

function colorJson(line: string): ReactNode {
  const parts = line.split(/("(?:\\.|[^"\\])*")/g)
  return parts.map((part, index) => {
    if (part.startsWith('"')) {
      return (
        <span key={index} className={part.endsWith(':') || line.includes(`${part}:`) ? 'text-moss' : 'text-hazard'}>
          {part}
        </span>
      )
    }
    return (
      <span key={index} className="text-smoke">
        {part}
      </span>
    )
  })
}
