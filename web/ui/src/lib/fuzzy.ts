/**
 * Tiny subsequence fuzzy match.
 *
 * A query matches when its characters appear in order. Consecutive hits and
 * hits after a separator score higher so "stm" prefers "SteamCMD" over a
 * line that just happens to contain those letters far apart.
 */

export interface FuzzyHit {
  score: number
  /** Character offsets in the original string that satisfied the query. */
  indices: number[]
}

export function fuzzyMatch(query: string, text: string): FuzzyHit | null {
  const needle = query.trim().toLocaleLowerCase()

  if (needle.length === 0) {
    return { score: 0, indices: [] }
  }

  const haystack = text.toLocaleLowerCase()
  const indices: number[] = []
  let cursor = 0
  let score = 0
  let run = 0

  for (const char of needle) {
    const found = haystack.indexOf(char, cursor)

    if (found === -1) {
      return null
    }

    const previous = indices[indices.length - 1]
    const consecutive = previous !== undefined && found === previous + 1
    const boundary = found === 0 || isBoundary(text.charCodeAt(found - 1))

    run = consecutive ? run + 1 : 0
    score += 1 + run * 4 + (boundary ? 3 : 0) - (found - cursor) * 0.05
    indices.push(found)
    cursor = found + 1
  }

  return { score, indices }
}

function isBoundary(code: number): boolean {
  return (
    code === 32 ||
    code === 9 ||
    code === 47 ||
    code === 46 ||
    code === 45 ||
    code === 95 ||
    code === 58 ||
    code === 91
  )
}

/** Split `text` into unmatched / matched runs for highlighting. */
export function fuzzySlices(
  text: string,
  indices: number[],
): { text: string; match: boolean }[] {
  if (indices.length === 0) {
    return [{ text, match: false }]
  }

  const marked = new Set(indices)
  const slices: { text: string; match: boolean }[] = []
  let buffer = ''
  let matching = marked.has(0)

  for (let index = 0; index < text.length; index += 1) {
    const next = marked.has(index)

    if (next !== matching && buffer.length > 0) {
      slices.push({ text: buffer, match: matching })
      buffer = ''
    }

    matching = next
    buffer += text[index]
  }

  if (buffer.length > 0) {
    slices.push({ text: buffer, match: matching })
  }

  return slices
}
