import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { ApiError, api, type MapTileJob } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useTranslation } from '@/i18n/use-translation'

/** A job that has not stopped: keep polling status and log. */
function isRunning(job: MapTileJob | undefined): boolean {
  return job?.status === 'queued' || job?.status === 'running'
}

/** `"41,38"` / `"41,38,2,2; 40,37"` → cell rects, or null if it is not that. */
function parseCells(input: string): number[][] | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  const rects: number[][] = []
  for (const chunk of trimmed.split(';')) {
    const part = chunk.trim()
    if (!part) {
      continue
    }
    const nums = part.split(',').map((value) => Number(value.trim()))
    if (nums.some((value) => !Number.isInteger(value) || value < 0)) {
      return null
    }
    if (nums.length === 2) {
      rects.push([nums[0], nums[1], 1, 1])
    } else if (nums.length === 4) {
      rects.push(nums)
    } else {
      return null
    }
  }
  return rects.length ? rects : null
}

interface MapUpdateDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * Start a regional map re-render and watch it run.
 *
 * Deliberately regional only. A full county rebuild takes hours and replaces
 * the live pack in place, which is not something to put one click away — that
 * stays `make map-tiles` on the host.
 *
 * The log is the renderer's own stdout, teed to `job.log` beside the pack by
 * `run.sh`. Polling by byte offset means a long run does not re-send megabytes
 * of per-tile output on every tick.
 */
export function MapUpdateDialog({ open, onClose }: MapUpdateDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const dialog = useRef<HTMLDialogElement>(null)
  const logBox = useRef<HTMLPreElement>(null)
  const titleId = useId()

  const [cells, setCells] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const offset = useRef(0)

  const parsed = parseCells(cells)

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

  const job = useQuery({
    queryKey: ['admin', 'map-tiles', 'jobs', jobId],
    queryFn: () => api.adminMapTileJob(jobId!),
    enabled: Boolean(jobId) && open,
    refetchInterval: (query) => (isRunning(query.state.data) ? 2_000 : false),
  })

  // One extra poll lands after the job stops, so the dialog shows the last
  // lines — the ones that say why it failed.
  const settled = useRef(false)
  useQuery({
    queryKey: ['admin', 'map-tiles', 'jobs', jobId, 'log'],
    enabled: Boolean(jobId) && open,
    refetchInterval: () => (isRunning(job.data) || !settled.current ? 1_500 : false),
    queryFn: async () => {
      const chunk = await api.adminMapTileJobLog(jobId!, offset.current)
      if (chunk.text) {
        // The reader rewinds when a new run truncated the file; start over
        // rather than splice this run onto the last one.
        setLog((previous) => (chunk.offset < offset.current ? chunk.text : previous + chunk.text))
      }
      offset.current = chunk.offset
      if (!isRunning(job.data)) {
        settled.current = true
      }
      return chunk
    },
  })

  useEffect(() => {
    const box = logBox.current
    if (box) {
      box.scrollTop = box.scrollHeight
    }
  }, [log])

  const start = useMutation({
    mutationFn: (input: number[][]) => api.adminRerenderMapTiles({ cells: input }),
    onSuccess: async (started) => {
      offset.current = 0
      settled.current = false
      setLog('')
      setJobId(started.id)
      await queryClient.invalidateQueries({ queryKey: ['admin', 'map-tiles'] })
    },
  })

  const busy = start.isPending || isRunning(job.data)
  const pct = Math.max(0, Math.min(100, job.data?.progress_pct ?? 0))
  const failure =
    start.error instanceof ApiError
      ? start.error.message
      : start.error
        ? t('auth.unexpected_error')
        : job.data?.error
          ? job.data.error
          : cells.trim() && !parsed
            ? t('admin.map_tiles_invalid')
            : null

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      closedby="closerequest"
      className="m-auto max-h-[min(44rem,calc(100vh-2rem))] w-[min(48rem,calc(100vw-2rem))] border border-fence-bright bg-ash p-0 text-bone backdrop:bg-void/80 open:flex open:flex-col"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (open) {
          onClose()
        }
      }}
    >
      <div className="shrink-0 p-5">
        <h2 id={titleId} className="display text-2xl text-bone">
          {t('admin.map_update_title')}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-smoke">{t('admin.map_update_hint')}</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 border-t border-fence px-5 py-4">
        <div className="grid shrink-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <Field
            label={t('admin.map_tiles_cells')}
            hint={t('admin.map_tiles_cells_hint')}
            value={cells}
            placeholder="41,38"
            disabled={busy}
            onChange={(event) => setCells(event.target.value)}
          />
          <Button size="sm" disabled={busy || !parsed} onClick={() => parsed && start.mutate(parsed)}>
            {busy ? t('admin.map_update_running') : t('admin.map_tiles_rerender')}
          </Button>
        </div>

        {jobId ? (
          <div className="shrink-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-xs tracking-widest text-dust uppercase">
                {job.data?.progress_stage ?? job.data?.status ?? '—'}
              </span>
              <span className="font-mono text-xs text-bone tabular-nums">{pct}%</span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t('admin.map_update_title')}
              className="mt-1 h-1.5 w-full overflow-hidden bg-fence"
            >
              <div
                className={cn(
                  'h-full transition-[width] duration-500',
                  job.data?.status === 'failed' ? 'bg-blood' : 'bg-moss',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : null}

        {failure ? (
          <p role="alert" className="shrink-0 border border-blood/40 px-3 py-2 font-mono text-xs text-blood">
            {failure}
          </p>
        ) : null}

        <pre
          ref={logBox}
          aria-live="polite"
          aria-label={t('admin.map_update_log')}
          className="min-h-0 flex-1 overflow-auto border border-fence bg-void/60 p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-smoke"
        >
          {log || t('admin.map_update_log_empty')}
        </pre>
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-fence px-5 py-3">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </dialog>
  )
}
