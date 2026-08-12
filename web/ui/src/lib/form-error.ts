import { ApiError } from '@/lib/api'

interface SplitError {
  /** Message belonging to a named input, keyed by field name. */
  fields: Record<string, string>
  /** Message that belongs to the form as a whole. */
  form: string | null
}

/**
 * Split a failed mutation into per-field and form-level messages.
 *
 * The API names the offending input on conflicts (`field: "username"`); every
 * other failure is the form's problem. Anything that is not an `ApiError` at
 * all is a bug on our side, so it gets a generic message rather than a stack
 * trace in the UI.
 */
export function splitError(
  error: unknown,
  fallback: string,
  knownFields: readonly string[],
): SplitError {
  if (!(error instanceof ApiError)) {
    return { fields: {}, form: error ? fallback : null }
  }

  if (error.field && knownFields.includes(error.field)) {
    return { fields: { [error.field]: error.message }, form: null }
  }

  return { fields: {}, form: error.message }
}
