import { twMerge } from 'tailwind-merge'

/**
 * Join conditional class names, letting later Tailwind utilities win.
 *
 * Plain concatenation is not enough: Tailwind emits its utilities in a fixed
 * order, so `cn('max-w-6xl', 'max-w-2xl')` would still render at `6xl` because
 * that rule comes later in the stylesheet. `twMerge` drops the losing class
 * instead, which is what a caller passing an override actually expects.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return twMerge(classes.filter(Boolean).join(' '))
}
