export interface ParsedModImport {
  mode: 'ini' | 'ids'
  workshopIds: string[]
  modIds: string[]
  mapFolders: string[]
}

const WORKSHOP_ID = /^\d{1,20}$/

function readIniValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=(.*)$`, 'im'))
  return match ? match[1]!.trim() : null
}

function splitList(value: string): string[] {
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

/**
 * Accepts server.ini lines or a bare list of Workshop ids.
 *
 * WorkshopItems= and Mods= are independent lists in PZ — one Workshop file
 * can contribute several Mods= tokens — so this does not pair them by index.
 */
export function parseModImport(text: string): ParsedModImport {
  const workshopLine = readIniValue(text, 'WorkshopItems')
  const modsLine = readIniValue(text, 'Mods')
  const mapLine = readIniValue(text, 'Map')
  const mapFolders = mapLine !== null ? dedupe(splitList(mapLine)) : []

  if (workshopLine !== null || modsLine !== null) {
    return {
      mode: 'ini',
      workshopIds: dedupe(
        (workshopLine !== null ? splitList(workshopLine) : []).filter((id) =>
          WORKSHOP_ID.test(id),
        ),
      ),
      modIds: dedupe(modsLine !== null ? splitList(modsLine) : []),
      mapFolders,
    }
  }

  return {
    mode: 'ids',
    workshopIds: dedupe(
      text
        .split(/[;,\s]+/)
        .map((token) => token.trim())
        .filter((id) => WORKSHOP_ID.test(id)),
    ),
    modIds: [],
    mapFolders,
  }
}
