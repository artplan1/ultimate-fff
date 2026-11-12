import { existsSync, opendirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
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

/** One `grep` call, as the tool accepts it. */
export type GrepRequest = {
  pattern: string
  path?: string
  glob?: string
  context?: number
  limit?: number
}

/** One `find` call, as the tool accepts it. */
export type FindRequest = { pattern: string; path?: string; glob?: string; limit?: number }

/** A `grep` call's pattern with the context and limit it runs with. */
type Wanted = { pattern: string; limit: number; context: number }

/**
 * Where a call searches: the indexed root, the conversation's working directory that its paths are reported against,
 * and the scope inside the root — a subdirectory prefix, or one file. A scope inside the working directory reuses its
 * index; anything else is indexed on its own.
 */
type Scope = { root: string; cwd: string; prefix: string; file?: string }

/** One indexed directory; `using` counts the calls holding it, so none is released underneath another. */
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

/** A `find` pattern is a glob when it uses glob syntax; anything else is a fuzzy path query. */
function isGlob(pattern: string) {
  return /[?*[{]/.test(pattern)
}

/** `path` resolved against the working directory: a scope inside it keeps its index, one outside is indexed alone. */
function scopeFor(cwd: string, path: string | undefined): Scope {
  if (path === undefined) return { root: cwd, cwd, prefix: '' }
  const wanted = resolve(cwd, path)
  if (!existsSync(wanted)) throw new Error(`Path not found: ${path}`)
  const isDirectory = statSync(wanted).isDirectory()
  const file = isDirectory ? undefined : wanted
  const root = file ? dirname(file) : wanted
  const inside = relative(cwd, root)
  const under = inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
  const prefix = under && inside !== '' ? inside.split(sep).join('/') + '/' : ''
  return {
    root: under ? cwd : root,
    cwd,
    prefix,
    ...(file === undefined ? {} : { file: prefix + basename(file) }),
  }
}

/** Whether an index-relative path lies inside the scope. */
function within(scope: Scope, path: string) {
  return scope.file === undefined ? path.startsWith(scope.prefix) : path === scope.file
}

/**
 * The scope as the model sees it: paths relative to the working directory, or absolute when the search lies outside
 * it, so every returned path can be read as it is.
 */
function shown(scope: Scope, result: SearchResult): SearchResult {
  if (scope.root === scope.cwd) return result
  return {
    ...result,
    items: result.items.map((item) => ({ ...item, path: resolve(scope.root, item.path) })),
  }
}

/** Whether the index holds a named file; one it does not hold is usually ignored, and searching it finds nothing. */
function indexed(finder: FileFinder, path: string) {
  const listing = finder.glob(path, { pageSize: 1 })
  return !listing.ok || listing.value.totalMatched > 0
}

/** Whether a directory holds no entries at all, so a search under it honestly finds nothing. */
function emptyDir(dir: string) {
  try {
    const opened = opendirSync(dir)
    try {
      return opened.readSync() === null
    } finally {
      opened.closeSync()
    }
  } catch {
    // One that cannot be read is not one known to be empty.
    return false
  }
}

/**
 * Refuse a directory the index holds nothing under, usually because it ignores it: such a search reports no matches
 * for a directory it never looked in. A directory empty on disk really has nothing to find.
 */
function requireIndexed(finder: FileFinder, scope: Scope, path: string) {
  if (scope.prefix === '') return
  const under = finder.glob(`${scope.prefix}**`, { pageSize: 1 })
  // A listing that failed says nothing about the index, so searching it stays the honest answer.
  if (!under.ok || under.value.totalMatched > 0) return
  if (emptyDir(resolve(scope.root, scope.prefix))) return
  throw new Error(
    `${path} is not in the search index, so nothing under it is searched; it is probably ignored. Read the file instead.`,
  )
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

/** Literal search with independent glob and scope filters and one extra match to prove more exist. */
function matches(
  finder: FileFinder,
  wanted: Wanted,
  scope: Scope,
  paths?: Set<string>,
): SearchResult {
  const hits: GrepMatch[] = []
  let cursor: GrepCursor | null = null
  while (hits.length <= wanted.limit) {
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
      if (!within(scope, match.relativePath) || (paths && !paths.has(match.relativePath)))
        continue
      hits.push(match)
      if (hits.length > wanted.limit) break
    }
    if (hits.length > wanted.limit || page.value.nextCursor === null) break
    cursor = page.value.nextCursor
  }
  const items = hits.slice(0, wanted.limit).map((match) => ({
    path: match.relativePath,
    line: match.lineNumber,
    text: match.lineContent,
    ...(match.contextBefore?.length ? { before: match.contextBefore } : {}),
    ...(match.contextAfter?.length ? { after: match.contextAfter } : {}),
  }))
  return { kind: 'content', items, total: items.length, more: hits.length > items.length ? 1 : 0 }
}

/**
 * A file listing narrowed to the scope and, when given, to the paths a glob matches. Narrowing fetches the whole match
 * set, as the index reports it, so the counts stay exact rather than guessed from a page.
 */
function listing(
  run: (pageSize: number) => Result<FileSearchResult>,
  scope: Scope,
  limit: number,
  paths?: Set<string>,
): SearchResult {
  const first = run(limit)
  if (!first.ok) throw new Error(`Search failed: ${first.error}`)
  const narrowed = scope.prefix !== '' || scope.file !== undefined || paths !== undefined
  const all =
    narrowed && first.value.totalMatched > first.value.items.length
      ? run(first.value.totalMatched)
      : first
  if (!all.ok) throw new Error(`Search failed: ${all.error}`)
  const items = all.value.items.filter(
    (item) => within(scope, item.relativePath) && (!paths || paths.has(item.relativePath)),
  )
  const total = narrowed ? items.length : all.value.totalMatched
  const page = items.slice(0, limit)
  return {
    kind: 'files',
    items: page.map((item) => ({ path: item.relativePath })),
    total,
    more: Math.max(total - page.length, 0),
  }
}

/**
 * The native finders, one per searched root, scanned once and owned by the calls that use them. An unused index is
 * released after `IDLE_MS`; `dispose` releases the rest when the extension unloads, keeping any still in use until its
 * last call finishes. Scans need no frecency or history database, so nothing is written to the searched tree.
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

  /** Wait for the scope's index; a scan that failed or timed out fails this call instead of searching it. */
  async function ready(index: Index) {
    await index.ready
    if (index.failed) throw new Error(index.failed)
  }

  return {
    async grep(request: GrepRequest, cwd: string): Promise<SearchResult> {
      if (request.pattern.includes('\n'))
        throw new Error(
          'A content pattern cannot contain a newline: content search is line by line.',
        )
      const scope = scopeFor(cwd, request.path)
      const wanted: Wanted = {
        pattern: request.pattern,
        limit: Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
        context: Math.min(request.context ?? DEFAULT_CONTEXT, MAX_CONTEXT),
      }
      const index = acquire(scope.root)
      try {
        await ready(index)
        const { finder } = index
        // A named file the index does not hold is usually ignored, so searching it would report no matches it never
        // looked for; say so instead.
        if (scope.file !== undefined && !indexed(finder, scope.file))
          throw new Error(
            `${request.path} is not in the search index, so its contents are not searched; it is probably ignored. Read the file instead.`,
          )
        // Likewise a directory the index holds nothing under was never searched.
        if (request.path !== undefined) requireIndexed(finder, scope, request.path)
        const paths =
          request.glob === undefined ? undefined : matchingPaths(finder, request.glob)
        // A glob that matches no file leaves nothing to search.
        if (paths?.size === 0) return { kind: 'content', items: [], total: 0, more: 0 }
        // Regex runs through rg; an expression rg rejects retries as literal text.
        const regex = isRegex(wanted.pattern)
          ? await searchRegex(wanted, {
              cwd: scope.root,
              path: scope.file ?? (scope.prefix || '.'),
              accept: (path) => within(scope, path) && (!paths || paths.has(path)),
            })
          : null
        return shown(scope, regex ?? matches(finder, wanted, scope, paths))
      } finally {
        release(scope.root, index)
      }
    },

    async find(request: FindRequest, cwd: string): Promise<SearchResult> {
      const scope = scopeFor(cwd, request.path)
      const limit = Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
      const index = acquire(scope.root)
      try {
        await ready(index)
        const { finder } = index
        if (request.path !== undefined) requireIndexed(finder, scope, request.path)
        const { pattern } = request
        // A glob narrows whatever the pattern finds, so a fuzzy match and a glob intersect.
        const paths = request.glob === undefined ? undefined : matchingPaths(finder, request.glob)
        if (paths?.size === 0) return { kind: 'files', items: [], total: 0, more: 0 }
        return shown(
          scope,
          listing(
            (pageSize) =>
              isGlob(pattern)
                ? finder.glob(pattern, { pageSize })
                : finder.fileSearch(pattern, { pageSize }),
            scope,
            limit,
            paths,
          ),
        )
      } finally {
        release(scope.root, index)
      }
    },

    /** Release every index no call is using; an index in use is released when its last call ends. */
    dispose() {
      closed = true
      for (const [cwd, index] of indexes) if (index.using === 0) drop(cwd, index)
    },
  }
}
