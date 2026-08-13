import { useId, type ComponentProps, type ReactNode } from 'react'

import { cn } from '@/lib/cn'

interface FieldProps extends Omit<ComponentProps<'input'>, 'id'> {
  label: string
  /** Message shown under the input; also marks the input invalid. */
  error?: string | null
  hint?: ReactNode
}

/**
 * Label, input and error message wired together.
 *
 * The error is linked with `aria-describedby` and the input flipped to
 * `aria-invalid`, so a screen reader announces the problem with the field
 * rather than leaving it as loose red text.
 */
export function Field({ label, error, hint, className, ...props }: FieldProps) {
  const id = useId()
  const errorId = `${id}-error`
  const hintId = `${id}-hint`

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={id}
        className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase"
      >
        {label}
      </label>

      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(error ? errorId : null, hint ? hintId : null) || undefined}
        className={cn(
          'h-12 border bg-void px-3 font-mono text-sm text-bone transition-colors',
          'placeholder:text-dust',
          // The global :focus-visible outline stays; the border change is an
          // extra cue, not the only one.
          error
            ? 'border-blood focus:border-blood'
            : 'border-fence-bright focus:border-hazard',
          className,
        )}
        {...props}
      />

      {hint ? (
        <p id={hintId} className="text-xs text-dust">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} className="text-xs text-blood">
          {error}
        </p>
      ) : null}
    </div>
  )
}

interface TextAreaFieldProps extends Omit<ComponentProps<'textarea'>, 'id'> {
  label: string
  error?: string | null
  hint?: ReactNode
}

/** Same wiring as Field, for longer copy. */
export function TextAreaField({
  label,
  error,
  hint,
  className,
  ...props
}: TextAreaFieldProps) {
  const id = useId()
  const errorId = `${id}-error`
  const hintId = `${id}-hint`

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={id}
        className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase"
      >
        {label}
      </label>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(error ? errorId : null, hint ? hintId : null) || undefined}
        className={cn(
          'min-h-28 border bg-void px-3 py-2 font-mono text-sm text-bone transition-colors',
          'placeholder:text-dust',
          error
            ? 'border-blood focus:border-blood'
            : 'border-fence-bright focus:border-hazard',
          className,
        )}
        {...props}
      />
      {hint ? (
        <p id={hintId} className="text-xs text-dust">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-blood">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Form-level error, for failures that belong to no single input. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="border border-blood/40 bg-blood-soft px-3 py-2.5 text-sm text-blood"
    >
      {children}
    </p>
  )
}
