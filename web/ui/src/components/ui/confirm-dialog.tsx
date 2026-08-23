import { useEffect, useId, useRef, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { useTranslation } from '@/i18n/use-translation'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: ReactNode
  /** Defaults to the common confirm label. */
  confirmLabel?: string
  /** Defaults to the common cancel label. */
  cancelLabel?: string
  /** Destructive actions use blood; everything else uses hazard. */
  tone?: 'primary' | 'danger'
  /** Form-heavy dialogs need more width than a one-line confirm. */
  size?: 'md' | 'lg' | 'xl'
  busy?: boolean
  confirmDisabled?: boolean
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
  cancelLabel,
  tone = 'primary',
  size = 'md',
  busy = false,
  confirmDisabled = false,
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
      className={cn(
        'm-auto border border-fence-bright bg-ash p-0 text-bone backdrop:bg-void/80',
        size === 'xl'
          ? 'max-h-[min(48rem,calc(100vh-2rem))] w-[min(48rem,calc(100vw-2rem))] open:flex open:flex-col'
          : size === 'lg'
            ? 'w-[min(36rem,calc(100vw-2rem))]'
            : 'w-[min(28rem,calc(100vw-2rem))]',
      )}
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
      <div className={cn('p-5', size === 'xl' && 'min-h-0 flex-1 overflow-y-auto')}>
        <h2 id={titleId} className="display text-2xl text-bone">
          {title}
        </h2>
        <div id={descriptionId} className="mt-3 text-sm leading-relaxed text-smoke">
          {description}
        </div>
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-fence px-5 py-3">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          {cancelLabel ?? t('common.cancel')}
        </Button>
        <Button
          variant={tone === 'danger' ? 'outline' : 'primary'}
          size="sm"
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
          className={tone === 'danger' ? 'border-blood text-blood hover:border-blood hover:text-blood' : undefined}
        >
          {busy ? t('common.saving') : (confirmLabel ?? t('common.confirm'))}
        </Button>
      </div>
    </dialog>
  )
}
