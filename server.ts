import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { createIndex, DEFAULT_CONTEXT, DEFAULT_LIMIT, MAX_CONTEXT, MAX_LIMIT } from './search.ts'
import type { SearchResult } from './types.ts'

/** The slice of Ultimate's extension host these tools use. Ultimate passes the whole host; only these two are read. */
type FffHost = {
  projectRoot: string
  onClose(fn: () => Promise<void>): void
}

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
  const tail = !result.more
    ? ''
    : result.kind === 'content'
      ? 'More matches than shown; raise limit or narrow the pattern, path or glob.'
      : `${result.more} more ${result.more === 1 ? 'file' : 'files'}; raise limit or narrow the pattern, path or glob.`
  return [head, ...result.items.map(itemText), tail].filter(Boolean).join('\n')
}

/**
 * The shape of `structuredContent`, which codemode hands to scripts instead of the text. Each tool declares the kind
 * it returns, so a script reads `result.items` without parsing prose.
 */
function resultSchema(kind: SearchResult['kind']) {
  return {
    type: 'object',
    properties: {
      kind: { const: kind },
      items: {
        type: 'array',
        description: 'Paths, or matched lines with their context, best match first.',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative to the working directory, or absolute outside it.',
            },
            line: { type: 'integer', description: '1-based line of the match; grep only.' },
            text: { type: 'string', description: 'The matching line; grep only.' },
            before: {
              type: 'array',
              items: { type: 'string' },
              description: 'Lines before the match, oldest first; grep only.',
            },
            after: {
              type: 'array',
              items: { type: 'string' },
              description: 'Lines after the match, in order; grep only.',
            },
          },
          required: ['path'],
        },
      },
      total: {
        type: 'integer',
        description:
          'Exact for find; for grep the number returned, since a full count means scanning every file.',
      },
      more: {
        type: 'integer',
        description: 'Beyond the page: exact for find, 1 for grep when one more match was proven.',
      },
    },
    required: ['kind', 'items', 'total', 'more'],
  }
}

/** The result on both channels: text for the model, and the object codemode scripts receive. */
function reply(result: SearchResult) {
  return {
    output: [{ type: 'text' as const, text: resultText(result) }],
    structuredContent: result,
  }
}

/**
 * Ultimate reads `outputSchema` from a registration, which Pi Durable's type does not carry, so it is attached beside
 * the tool rather than inside `defineTool`.
 */
function structured(tool: ToolRegistration, kind: SearchResult['kind']) {
  return { ...tool, outputSchema: resultSchema(kind) }
}

/** What `path` means for both tools, written once so the two descriptions cannot drift apart. */
const pathText =
  'File or directory to search, relative to the working directory or absolute. Inside it, the search reuses the working directory index; outside, that directory is indexed on its own. Default: the working directory.'

export default function fff(host: FffHost) {
  const index = createIndex()
  host.onClose(async () => index.dispose())
  const grep = defineTool({
    name: 'grep',
    // No frecency or history writes: replay only reads the index.
    replay: 'safe',
    description:
      "Search file contents in the conversation's working directory, or under path. Read-only: fff indexes literal text; a pattern that uses regex syntax and compiles runs ripgrep (rg required), and an expression rg rejects retries as literal text. Smart-case: uppercase makes matching case-sensitive. Returns matching lines with the lines of context around them; content counts cover only returned matches.",
    parameters: obj({
      pattern: str({
        minLength: 1,
        description:
          'Content pattern: a regex when it uses regex syntax and compiles, otherwise literal text. Matched line by line, so it cannot contain a newline.',
      }),
      path: opt(str({ minLength: 1, description: pathText })),
      glob: opt(
        str({
          minLength: 1,
          description: 'Path filter, e.g. "src/**/*.ts", matched by the index over paths.',
        }),
      ),
      context: opt(
        int({
          minimum: 0,
          maximum: MAX_CONTEXT,
          description: `Lines of context before and after each match; default ${DEFAULT_CONTEXT}.`,
        }),
      ),
      limit: opt(
        int({
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum matches returned; default ${DEFAULT_LIMIT}.`,
        }),
      ),
    }),
    async execute(args, api, context) {
      const result = await index.grep(args, api.env?.cwd ?? host.projectRoot)
      await api.details(result, context)
      return reply(result)
    },
  })
  const find = defineTool({
    name: 'find',
    replay: 'safe',
    description:
      "Find files by path in the conversation's working directory, or under path. Read-only. A pattern with glob syntax (e.g. \"src/**/*.ts\") is listed exactly as a glob; any other pattern is a fuzzy path match, so words find a file whose path contains them. glob narrows either.",
    parameters: obj({
      pattern: str({
        minLength: 1,
        description:
          'Fuzzy path when it is words, e.g. "workflow runner"; an exact glob when it uses glob syntax: "?", "*", "[" or "{", e.g. "src/**/*.ts".',
      }),
      path: opt(str({ minLength: 1, description: pathText })),
      glob: opt(
        str({
          minLength: 1,
          description:
            'Path filter, e.g. "src/**/*.ts", intersected with the pattern. The index lists matching files, and a glob that matches none leaves nothing to find.',
        }),
      ),
      limit: opt(
        int({
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum files returned; default ${DEFAULT_LIMIT}.`,
        }),
      ),
    }),
    async execute(args, api, context) {
      const result = await index.find(args, api.env?.cwd ?? host.projectRoot)
      await api.details(result, context)
      return reply(result)
    },
  })
  return defineExtension({
    name: 'fff',
    sections: [
      section(
        'fff',
        () =>
          'Use grep first for content search and find for file discovery. Prefer bare identifiers for efficient content matching, narrow with path or glob, and read files when you need more context.',
      ),
    ],
    tools: [structured(grep, 'content'), structured(find, 'files')],
  })
}
