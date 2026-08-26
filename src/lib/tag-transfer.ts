import { MAX_TAGS_PER_CHANNEL, TAG_COLORS, type Tag } from './types'

// Tag export/import as a JSON file: the one way to move tags between browsers
// or accounts (there is no backend). Rows travel without `id`/`userId` — those
// are local storage keys, so the importing side mints its own — and merge by
// name, which is what already identifies a tag to the user (names are unique
// per account, see App's onCreate).

/** One tag as it appears in an export file. */
export interface PortableTag {
  name: string
  /** One of `TAG_COLORS`; anything else is ignored on import. */
  color?: string
  /** YouTube channel ids, which are global — assignments survive the move. */
  channelIds: string[]
}

/** Marks the file as ours, so importing an unrelated JSON fails loudly. */
const FILE_KIND = 'youtube-decomposer-tags'
const FILE_VERSION = 1

export function serializeTags(tags: Tag[]): string {
  return JSON.stringify(
    {
      kind: FILE_KIND,
      version: FILE_VERSION,
      tags: tags.map(({ name, color, channelIds }) => ({ name, color, channelIds })),
    },
    null,
    2,
  )
}

/**
 * Parses and validates an export file. Throws an `Error` whose message is fit
 * to show the user. Lenient where it can afford to be — unknown fields, bad
 * colors and non-string channel ids are dropped, and duplicate names within
 * the file are unioned — but a missing/foreign `kind` or a nameless tag means
 * the file is not ours, and that must fail rather than half-import.
 */
export function parseTagsFile(text: string): PortableTag[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Not a JSON file.')
  }
  if (typeof data !== 'object' || data === null || (data as { kind?: unknown }).kind !== FILE_KIND) {
    throw new Error('Not a tag export file.')
  }
  const rows = (data as { tags?: unknown }).tags
  if (!Array.isArray(rows)) throw new Error('The file has no tags.')

  // Union duplicates by name as we go, so the merge below sees each name once.
  const byName = new Map<string, PortableTag>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) throw new Error('The file is malformed.')
    const { name, color, channelIds } = row as Record<string, unknown>
    if (typeof name !== 'string' || !name.trim()) throw new Error('The file is malformed.')
    const trimmed = name.trim()
    const key = trimmed.toLowerCase()
    const ids = Array.isArray(channelIds)
      ? channelIds.filter((id): id is string => typeof id === 'string')
      : []
    const seen = byName.get(key)
    if (seen) {
      seen.channelIds = [...new Set([...seen.channelIds, ...ids])]
    } else {
      byName.set(key, {
        name: trimmed,
        color:
          typeof color === 'string' && (TAG_COLORS as readonly string[]).includes(color)
            ? color
            : undefined,
        channelIds: [...new Set(ids)],
      })
    }
  }
  return [...byName.values()]
}

export interface TagMergeResult {
  /** The full next tag list, existing rows included. */
  tags: Tag[]
  /** New and updated rows only — what actually needs persisting. */
  changed: Tag[]
  created: number
  merged: number
  /** Assignments dropped because the channel was at `MAX_TAGS_PER_CHANNEL`. */
  skippedAssignments: number
}

/**
 * Merges imported tags into the existing list, additively: an imported name
 * that already exists gains the imported channel assignments but keeps its
 * local color and casing; an unknown name becomes a new tag. Nothing local is
 * ever removed or recolored, so importing is safe to repeat — a second import
 * of the same file is a no-op. The per-channel tag cap is enforced the same
 * way the UI enforces it: assignments past it are dropped, and counted so the
 * caller can say so.
 */
export function mergeTags(existing: Tag[], imported: PortableTag[], userId: string): TagMergeResult {
  const tags = existing.map((t) => ({ ...t, channelIds: [...t.channelIds] }))
  const byName = new Map(tags.map((t) => [t.name.toLowerCase(), t]))
  const tagsPerChannel = new Map<string, number>()
  for (const tag of tags)
    for (const id of tag.channelIds) tagsPerChannel.set(id, (tagsPerChannel.get(id) ?? 0) + 1)

  const changed: Tag[] = []
  let created = 0
  let merged = 0
  let skippedAssignments = 0

  for (const row of imported) {
    let tag = byName.get(row.name.toLowerCase())
    const isNew = !tag
    if (!tag) {
      tag = {
        id: crypto.randomUUID(),
        userId,
        name: row.name,
        // Same palette walk as creating a tag by hand (see App's onCreate).
        color: row.color ?? TAG_COLORS[tags.length % TAG_COLORS.length],
        channelIds: [],
      }
      tags.push(tag)
      byName.set(row.name.toLowerCase(), tag)
    }

    let grew = false
    for (const channelId of row.channelIds) {
      if (tag.channelIds.includes(channelId)) continue
      const count = tagsPerChannel.get(channelId) ?? 0
      if (count >= MAX_TAGS_PER_CHANNEL) {
        skippedAssignments++
        continue
      }
      tag.channelIds.push(channelId)
      tagsPerChannel.set(channelId, count + 1)
      grew = true
    }

    if (isNew) {
      created++
      changed.push(tag)
    } else if (grew) {
      merged++
      changed.push(tag)
    }
  }

  return { tags, changed, created, merged, skippedAssignments }
}
