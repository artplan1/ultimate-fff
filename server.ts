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
          'Use search first for file discovery and content search. Prefer bare identifiers for efficient content matching, narrow with glob, and read files when you need more context.',
      ),
    ],
    tools: [
      defineTool({
        name: 'search',
        // No frecency or history writes: replay only reads the index.
        replay: 'safe',
        description:
          "Find file paths and search contents in the conversation's working directory. Read-only: fff indexes paths and literal text; regex runs ripgrep (rg required). Smart-case: uppercase makes content matching case-sensitive. Returns paths, lines and context; content counts cover only returned matches.",
        parameters: obj({
          query: opt(
            str({
              minLength: 1,
              description:
                'Fuzzy file path, e.g. "workflow runner". Use query or pattern, not both.',
            }),
          ),
          pattern: opt(
            str({
              minLength: 1,
              description:
                "Content pattern: auto-detects regex syntax, otherwise literal. Regex uses rg's default engine, without rewriting the pattern. Invalid or unsupported expressions stay literal.",
            }),
          ),
          glob: opt(
            str({
              minLength: 1,
              description: 'Path filter, e.g. "src/**/*.ts". On its own, lists matching files.',
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
