import { Fragment } from 'react'
import { Tool, ToolContent, ToolDiagnostics, ToolHeader, ToolOutput } from '@/components/ai/tool'
import { defineWebExtension, useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import type { SearchResult } from './types.ts'

function excerpt(item: SearchResult['items'][number]) {
  const line = item.line
  if (line === undefined) return []
  return [
    ...(item.before ?? []).map((text, offset) => ({
      line: line - (item.before?.length ?? 0) + offset,
      text,
      match: false,
    })),
    { line, text: item.text, match: true },
    ...(item.after ?? []).map((text, offset) => ({
      line: line + offset + 1,
      text,
      match: false,
    })),
  ]
}

/** One card for both tools: the pattern searched, its scope, then paths, or matched lines grouped by file. */
function Matches({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const result = call.details as SearchResult | undefined
  const failed = call.status === 'error'
  const pattern = call.args.pattern
  const title = typeof pattern === 'string' ? pattern : ''
  // `path` and `glob` narrow what was searched, so the call shows them beside the counts.
  const scope = [call.args.path, call.args.glob].filter(
    (value): value is string => typeof value === 'string',
  )
  const groups = new Map<string, SearchResult['items']>()
  for (const item of result?.items ?? []) {
    const items = groups.get(item.path) ?? []
    items.push(item)
    groups.set(item.path, items)
  }
  return (
    <Tool defaultOpen={failed}>
      <ToolHeader
        name={call.name}
        state={call.status}
        title={title}
        meta={
          <>
            {scope.map((value) => (
              <span key={value}>{value}</span>
            ))}
            {result && (
              <span>
                {result.total}
                {result.kind === 'content' && result.more > 0 ? '+' : ''}{' '}
                {result.kind === 'files' ? 'files' : 'matches'}
              </span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
      />
      <ToolContent>
        {failed || !result ? (
          <ToolOutput isError={failed} output={call.output} />
        ) : (
          <div className="max-h-96 overflow-auto font-mono text-xs">
            {groups.size === 0 && (
              <div className="px-2.5 py-2 whitespace-pre-wrap text-muted-foreground">
                {call.output || 'No matches'}
              </div>
            )}
            {[...groups].map(([path, items]) => (
              <div key={path} className="border-b border-border/50 last:border-b-0">
                <div className="bg-muted/30 px-2.5 py-1.5 break-all text-foreground/90">{path}</div>
                {items.map((item, index) =>
                  item.line === undefined ? null : (
                    <Fragment key={item.line}>
                      {index > 0 && <div className="px-2.5 text-muted-foreground/50">···</div>}
                      {excerpt(item).map((row) => (
                        <div
                          key={row.line}
                          className={`flex gap-3 px-2.5 leading-5 ${row.match ? 'bg-brand/5 text-foreground' : 'text-muted-foreground'}`}
                        >
                          <span className="w-10 shrink-0 text-right text-muted-foreground/60 select-none">
                            {row.line}
                          </span>
                          <pre className="min-w-0 whitespace-pre-wrap break-all">{row.text}</pre>
                        </div>
                      ))}
                    </Fragment>
                  ),
                )}
              </div>
            ))}
            {result.more > 0 && (
              <div className="border-t border-border/50 px-2.5 py-2 text-muted-foreground">
                {result.kind === 'files' ? `${result.more} more files` : 'More matches than shown'}
              </div>
            )}
          </div>
        )}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({ tools: { grep: Matches, find: Matches } })
