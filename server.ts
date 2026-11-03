import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'

/** The slice of Ultimate's extension host this tool uses. Ultimate passes the whole host; only these two are read. */
type SearchHost = {
  projectRoot: string
  onClose(fn: () => Promise<void>): void
}
import { createIndex, DEFAULT_CONTEXT, DEFAULT_LIMIT, MAX_CONTEXT, MAX_LIMIT } from './search.ts'
import type { SearchResult } from './types.ts'

/** One file in a result: its path, or a matched line with the numbered context around it. */
function itemText(item: SearchResult['items'][number]): string {
  if (item.line === undefined) return item.path
  const line = item.line
  const before = item.before ?? []
  const after = item.after ?? []
  return [
    ...before.map((text, index) => `${item.path}:${line - before.length + index}: ${text}`),
    `${item.path}:${line}: ${item.text}`,
    ...after.map((text, index) => `${item.path}:${line + index + 1}: ${text}`),
  ].join('\n')
}

/** The result as the model reads it, carrying what the details carry. */
function resultText(result: SearchResult): string {
  if (!result.items.length) return result.kind === 'files' ? 'No files match.' : 'No matches.'
  const head =
    result.kind === 'files'
      ? `Found ${result.total} ${result.total === 1 ? 'file' : 'files'}${result.more ? `, showing ${result.items.length}` : ''}:`
      : `Showing ${result.items.length} ${result.items.length === 1 ? 'match' : 'matches'}:`
  const tail =
    result.kind === 'content'
      ? result.more
        ? 'More matches than shown; raise limit or narrow the pattern or glob.'
        : ''
      : result.more
        ? `${result.more} more ${result.more === 1 ? 'file' : 'files'}; raise limit or narrow the glob.`
        : ''
  return [head, ...result.items.map(itemText), tail].filter(Boolean).join('\n')
}

export default function search(host: SearchHost) {
  const index = createIndex()
  host.onClose(async () => index.dispose())
  return defineExtension({
    name: 'search',
    sections: [
      section(
        'search',
        () =>
          'Use search for project file discovery and content search instead of bash rg, grep, find or ls. Use query for fuzzy file paths, pattern for content (a regular expression when it has regex syntax, literal text otherwise), or glob alone to list files; narrow with glob and read the matching files for full context. Search is read-only and returns bounded results; content counts with more matches are lower bounds.',
      ),
    ],
    tools: [
      defineTool({
        name: 'search',
        // Every search only reads the index and writes no frecency or history database, so a rerun cannot do harm.
        replay: 'safe',
        description: `Search files and the text inside them from a native index of the conversation's working directory. Prefer it over bash rg, grep, find or ls: query finds files by fuzzy path, pattern searches contents (a regular expression when the pattern uses regex syntax, literal text otherwise), glob filters either or lists files on its own, and one call returns relative paths, line numbers and context. The index follows file changes, so new files show up without a rescan. Read-only: it changes nothing in the project. limit defaults to ${DEFAULT_LIMIT} items (max ${MAX_LIMIT}) and context to ${DEFAULT_CONTEXT} lines (max ${MAX_CONTEXT}).`,
        parameters: obj({
          query: opt(
            str({
              minLength: 1,
              description:
                'Fuzzy path to find files by, such as a file name or path fragments like "workflow runner". Omit to search contents or list files by glob.',
            }),
          ),
          pattern: opt(
            str({
              minLength: 1,
              description:
                'Text to search for inside files. Treated as a regular expression when it uses regex syntax and compiles, otherwise as literal text. Omit to find files instead.',
            }),
          ),
          glob: opt(
            str({
              minLength: 1,
              description:
                'Glob limiting the search, such as "src/**/*.ts"; on its own it lists the files that match.',
            }),
          ),
          context: opt(
            int({
              minimum: 0,
              maximum: MAX_CONTEXT,
              description: `Lines of context before and after each content match; default ${DEFAULT_CONTEXT}.`,
            }),
          ),
          limit: opt(
            int({
              minimum: 1,
              maximum: MAX_LIMIT,
              description: `Maximum items returned; default ${DEFAULT_LIMIT}.`,
            }),
          ),
        }),
        async execute(args, api, context) {
          const result = await index.search(args, api.env?.cwd ?? host.projectRoot)
          await api.details(result, context)
          return { output: [{ type: 'text', text: resultText(result) }] }
        },
      }),
    ],
  })
}
