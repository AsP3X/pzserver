import { useEffect, useId, useRef, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/use-translation'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: ReactNode
  /** Defaults to the common confirm label. */
  confirmLabel?: string
  /** Destructive actions use blood; everything else uses hazard. */
  tone?: 'primary' | 'danger'
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}

/**
 * Modal confirmation for irreversible or noisy actions.
 *
 * Native `<dialog>` so focus is trapped, Escape cancels, and a screen reader
 * announces it as a dialog rather than as a div that appeared.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  busy = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

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

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] border border-fence-bright bg-ash p-0 text-bone backdrop:bg-void/80"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) {
          onClose()
        }
      }}
      onClose={() => {
        if (open) {
          onClose()
        }
      }}
    >
      <div className="p-5">
        <h2 id={titleId} className="display text-2xl text-bone">
          {title}
        </h2>
        <div id={descriptionId} className="mt-3 text-sm leading-relaxed text-smoke">
          {description}
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t border-fence px-5 py-3">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button
          variant={tone === 'danger' ? 'outline' : 'primary'}
          size="sm"
          onClick={onConfirm}
          disabled={busy}
          className={tone === 'danger' ? 'border-blood text-blood hover:border-blood hover:text-blood' : undefined}
        >
          {busy ? t('common.saving') : (confirmLabel ?? t('common.confirm'))}
        </Button>
      </div>
    </dialog>
  )
}
