import { FileFinder } from '@ff-labs/fff-node'
import type {
  GrepCursor,
  GrepMatch,
  Result,
  SearchResult as FileSearchResult,
} from '@ff-labs/fff-node'
import type { SearchResult } from './types.ts'
import { searchRegex } from './regex.ts'

/** How long an index nobody is searching stays before its native finder is released. */
export const IDLE_MS = 5 * 60_000
/** A first scan that takes longer fails the call instead of searching half an index. */
const SCAN_MS = 30_000
export const DEFAULT_LIMIT = 30
export const MAX_LIMIT = 100
export const DEFAULT_CONTEXT = 2
export const MAX_CONTEXT = 10

/** One `search` call, as the tool accepts it. */
export type SearchRequest = {
  query?: string
  pattern?: string
  glob?: string
  context?: number
  limit?: number
}

/** What one validated request runs: a glob listing, a fuzzy path search, or a content search. */
type Plan =
  | { kind: 'files'; call: 'glob' | 'query'; term: string; glob?: string; limit: number }
  | {
      kind: 'content'
      pattern: string
      regex: boolean
      glob?: string
      limit: number
      context: number
    }

/** One indexed working directory; `using` counts the calls holding it, so none is released underneath another. */
type Index = {
  finder: FileFinder
  ready: Promise<void>
  using: number
  failed?: string
  idle?: ReturnType<typeof setTimeout>
}

/** A pattern is a regular expression when it uses regex syntax and compiles; anything else is literal text. */
function isRegex(pattern: string) {
  if (!/[.*+?^${}()|[\]\\]/.test(pattern)) return false
  try {
    RegExp(pattern)
    return true
  } catch {
    return false
  }
}

function plan(request: SearchRequest): Plan {
  const { query, pattern, glob } = request
  if (query !== undefined && pattern !== undefined)
    throw new Error(
      'Pass either query (find files by path) or pattern (search file contents), not both.',
    )
  if (pattern === undefined && request.context !== undefined)
    throw new Error('context applies to content search; pass pattern to use it.')
  const limit = Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  if (pattern !== undefined) {
    if (pattern.includes('\n'))
      throw new Error('A content pattern cannot contain a newline: content search is line by line.')
    return {
      kind: 'content',
      pattern,
      regex: isRegex(pattern),
      ...(glob ? { glob } : {}),
      limit,
      context: Math.min(request.context ?? DEFAULT_CONTEXT, MAX_CONTEXT),
    }
  }
  if (query !== undefined) return { kind: 'files', call: 'query', term: query, glob, limit }
  if (glob === undefined)
    throw new Error(
      'Pass query (fuzzy path search), pattern (content search) or glob (file filter or listing).',
    )
  return { kind: 'files', call: 'glob', term: glob, limit }
}

function found(result: Result<FileSearchResult>, limit: number): SearchResult {
  if (!result.ok) throw new Error(`Search failed: ${result.error}`)
  const items = result.value.items.slice(0, limit).map((item) => ({ path: item.relativePath }))
  return {
    kind: 'files',
    items,
    total: result.value.totalMatched,
    more: Math.max(result.value.totalMatched - items.length, 0),
  }
}

/** The paths a glob matches, as the glob listing itself reports them, to filter a content search by. */
function matchingPaths(finder: FileFinder, glob: string): Set<string> {
  const paths = new Set<string>()
  const first = finder.glob(glob, { pageSize: 1000 })
  if (!first.ok) throw new Error(`Search failed: ${first.error}`)
  for (const item of first.value.items) paths.add(item.relativePath)
  if (paths.size < first.value.totalMatched) {
    // The index knows the exact count, so one full-size page collects the rest.
    const rest = finder.glob(glob, { pageSize: first.value.totalMatched })
    if (!rest.ok) throw new Error(`Search failed: ${rest.error}`)
    for (const item of rest.value.items) paths.add(item.relativePath)
  }
  return paths
}

/** Literal search with an independent glob filter and one extra match to prove more exist. */
function matches(
  finder: FileFinder,
  wanted: Extract<Plan, { kind: 'content' }>,
  paths?: Set<string>,
): SearchResult {
  const shown: GrepMatch[] = []
  let cursor: GrepCursor | null = null
  while (shown.length <= wanted.limit) {
    // multiGrep preserves literal text; grep's query parser would rewrite it.
    const page = finder.multiGrep({
      patterns: [wanted.pattern],
      pageSize: wanted.limit + 1,
      maxMatchesPerFile: wanted.limit + 1,
      beforeContext: wanted.context,
      afterContext: wanted.context,
      cursor,
    })
    if (!page.ok) throw new Error(`Search failed: ${page.error}`)
    for (const match of page.value.items) {
      if (paths && !paths.has(match.relativePath)) continue
      shown.push(match)
      if (shown.length > wanted.limit) break
    }
    if (shown.length > wanted.limit || page.value.nextCursor === null) break
    cursor = page.value.nextCursor
  }
  const items = shown.slice(0, wanted.limit).map((match) => ({
    path: match.relativePath,
    line: match.lineNumber,
    text: match.lineContent,
    ...(match.contextBefore?.length ? { before: match.contextBefore } : {}),
    ...(match.contextAfter?.length ? { after: match.contextAfter } : {}),
  }))
  return { kind: 'content', items, total: items.length, more: shown.length > items.length ? 1 : 0 }
}

/**
 * The native finders, one per working directory, scanned once and owned by the calls that use them. An unused index
 * is released after `IDLE_MS`; `dispose` releases the rest when the extension unloads, keeping any still in use until
 * its last call finishes. Scans need no frecency or history database, so nothing is written to the searched tree.
 */
export function createIndex() {
  const indexes = new Map<string, Index>()
  let closed = false

  function open(cwd: string): Index {
    const created = FileFinder.create({ basePath: cwd, aiMode: true })
    if (!created.ok) throw new Error(`Cannot index ${cwd}: ${created.error}`)
    const finder = created.value
    const index: Index = { finder, ready: Promise.resolve(), using: 0 }
    index.ready = finder.waitForScan(SCAN_MS).then((scanned) => {
      if (scanned.ok && scanned.value) return
      // A later call may try again; this one fails rather than searching a partial index.
      if (indexes.get(cwd) === index) indexes.delete(cwd)
      index.failed = scanned.ok
        ? `Indexing ${cwd} did not finish within ${SCAN_MS / 1000} s`
        : `Indexing ${cwd} failed: ${scanned.error}`
    })
    return index
  }

  function acquire(cwd: string) {
    const index = indexes.get(cwd) ?? open(cwd)
    indexes.set(cwd, index)
    index.using++
    if (index.idle) clearTimeout(index.idle)
    index.idle = undefined
    return index
  }

  function drop(cwd: string, index: Index) {
    if (index.idle) clearTimeout(index.idle)
    index.idle = undefined
    if (indexes.get(cwd) === index) indexes.delete(cwd)
    index.finder.destroy()
  }

  function release(cwd: string, index: Index) {
    index.using--
    if (index.using > 0) return
    // An index that left the cache (a failed scan) or a closing extension drops at once; a cached one idles first.
    if (closed || indexes.get(cwd) !== index) {
      drop(cwd, index)
      return
    }
    index.idle = setTimeout(() => {
      index.idle = undefined
      if (index.using === 0) drop(cwd, index)
    }, IDLE_MS)
    // An idle index must not keep a short-lived process alive until it evicts.
    index.idle.unref?.()
  }

  return {
    async search(request: SearchRequest, cwd: string): Promise<SearchResult> {
      const wanted = plan(request)
      const index = acquire(cwd)
      try {
        await index.ready
        if (index.failed) throw new Error(index.failed)
        const { finder } = index
        if (wanted.kind === 'content') {
          const paths = wanted.glob === undefined ? undefined : matchingPaths(finder, wanted.glob)
          // A glob that matches no file leaves nothing to search.
          if (paths?.size === 0) return { kind: 'content', items: [], total: 0, more: 0 }
          if (wanted.regex) {
            const result = await searchRegex(wanted, cwd, paths)
            if (result) return result
          }
          return matches(finder, wanted, paths)
        }
        if (wanted.call === 'glob')
          return found(finder.glob(wanted.term, { pageSize: wanted.limit }), wanted.limit)
        let result = finder.fileSearch(wanted.term, { pageSize: wanted.limit })
        if (wanted.glob && result.ok && result.value.totalMatched > 0) {
          const paths = matchingPaths(finder, wanted.glob)
          result = finder.fileSearch(wanted.term, { pageSize: result.value.totalMatched })
          if (result.ok) {
            const items = result.value.items.filter((item) => paths.has(item.relativePath))
            result = { ok: true, value: { ...result.value, items, totalMatched: items.length } }
          }
        }
        return found(result, wanted.limit)
      } finally {
        release(cwd, index)
      }
    },
    /** Release every index no call is using; an index in use is released when its last call ends. */
    dispose() {
      closed = true
      for (const [cwd, index] of indexes) if (index.using === 0) drop(cwd, index)
    },
  }
}
