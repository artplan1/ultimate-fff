import { spawn } from 'node:child_process'
import { relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { SearchResult } from './types.ts'

/** rg JSON uses base64 when a path or source line is not UTF-8. */
function text(value: { text?: string; bytes?: string }): string {
  return value.text ?? Buffer.from(value.bytes!, 'base64').toString('utf8')
}

/** Raw regex search; null asks the caller to retry an unsupported expression literally. */
export async function searchRegex(
  wanted: { pattern: string; context: number; limit: number },
  search: { cwd: string; path: string; accept: (path: string) => boolean },
): Promise<SearchResult | null> {
  const child = spawn(
    'rg',
    [
      '--no-config',
      '--json',
      '--smart-case',
      '--max-filesize=10M',
      `--max-count=${wanted.limit + 1}`,
      `--context=${wanted.context}`,
      '--regexp',
      wanted.pattern,
      '--',
      // The scope itself, so a narrowed search does not walk the whole root.
      search.path,
    ],
    { cwd: search.cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let failure: Error | undefined
  child.on('error', (error) => (failure = error))
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.once('close', (code, signal) => done({ code, signal })),
  )
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    // Retain the first diagnostic, but keep draining errors after the retained window fills.
    stderr += chunk.slice(0, Math.max(8192 - stderr.length, 0))
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const shown: SearchResult['items'] = []
  let before: string[] = []
  let previousLine = 0
  let stopped = false
  let contextEnded = false
  try {
    for await (const line of lines) {
      const event = JSON.parse(line)
      if (event.type === 'begin') {
        before = []
        previousLine = 0
      }
      if (event.type === 'match' || event.type === 'context') {
        const data = event.data
        const path = relative(search.cwd, resolve(search.cwd, text(data.path)))
          .split(sep)
          .join('/')
        if (!search.accept(path)) continue
        const number: number = data.line_number
        const source = text(data.lines).replace(/\r?\n$/, '')
        if (number !== previousLine + 1) before = []
        for (const item of shown) {
          if (item.path === path && number > item.line! && number <= item.line! + wanted.context)
            (item.after ??= []).push(source)
        }
        if (event.type === 'match')
          shown.push({
            path,
            line: number,
            text: source,
            ...(before.length ? { before: [...before] } : {}),
          })
        before = wanted.context ? [...before, source].slice(-wanted.context) : []
        previousLine = number
      }
      // EOF also completes context when fewer lines remain than requested.
      if (event.type === 'end' && shown.length >= wanted.limit) contextEnded = true
      if (
        shown.length > wanted.limit &&
        (contextEnded || (shown[wanted.limit - 1].after?.length ?? 0) >= wanted.context)
      ) {
        stopped = true
        child.kill()
        break
      }
    }
  } catch (error) {
    child.kill()
    await closed
    throw error
  } finally {
    lines.close()
  }
  const { code, signal } = await closed
  if (failure) {
    if ('code' in failure && failure.code === 'ENOENT')
      throw new Error('Regex search requires ripgrep (rg) on PATH. Install ripgrep and retry.')
    throw failure
  }
  const ownStop = stopped && signal === 'SIGTERM'
  if (stderr.trim() || (code !== 0 && code !== 1 && !ownStop)) {
    if (code === 2 && stderr.startsWith('rg: regex parse error:')) return null
    throw new Error(`Regex search failed: ${stderr.trim() || `rg exited with ${code ?? signal}`}`)
  }
  const items = shown.slice(0, wanted.limit)
  return { kind: 'content', items, total: items.length, more: shown.length > items.length ? 1 : 0 }
}
