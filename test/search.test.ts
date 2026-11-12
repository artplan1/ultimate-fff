import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createIndex } from '../search.ts'
import fff from '../server.ts'

/** A working directory to search and, beside it, one to search from outside. */
let cwd = ''
let external = ''
const index = createIndex()

function file(root: string, path: string, content: string) {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), content)
}

before(() => {
  cwd = mkdtempSync(join(tmpdir(), 'fff-cwd-'))
  external = mkdtempSync(join(tmpdir(), 'fff-outside-'))
  file(cwd, 'root.ts', 'NEEDLE upper\n')
  file(cwd, 'src/app.ts', "export const handler = defineThing('value')\n")
  file(cwd, 'src/nested/deep.ts', 'const needle = 1\n')
  file(cwd, 'src/window.txt', 'alpha\ntarget\nomega\n')
  file(cwd, 'docs/guide.md', 'needle in docs\n')
  file(cwd, '.gitignore', 'hidden.txt\nignored/\n')
  file(cwd, 'hidden.txt', 'needle hidden\n')
  file(cwd, 'ignored/skip.ts', 'needle ignored\n')
  mkdirSync(join(cwd, 'empty'))
  file(external, 'other.ts', 'external needle\n')
})

after(() => {
  index.dispose()
  rmSync(cwd, { recursive: true, force: true })
  rmSync(external, { recursive: true, force: true })
})

const paths = (result: { items: { path: string }[] }) => result.items.map((item) => item.path)

test('find lists a glob exactly and matches a path fuzzily', async () => {
  const globbed = await index.find({ pattern: '**/*.ts' }, cwd)
  assert.deepEqual(paths(globbed).sort(), ['root.ts', 'src/app.ts', 'src/nested/deep.ts'])
  assert.equal(globbed.kind, 'files')
  assert.equal(globbed.total, 3)
  assert.ok(paths(await index.find({ pattern: 'deep' }, cwd)).includes('src/nested/deep.ts'))
})

test('find scopes to a directory and to a single file', async () => {
  const directory = await index.find({ pattern: '**/*', path: 'src' }, cwd)
  assert.deepEqual(paths(directory).sort(), [
    'src/app.ts',
    'src/nested/deep.ts',
    'src/window.txt',
  ])
  const one = await index.find({ pattern: '*', path: 'src/app.ts' }, cwd)
  assert.deepEqual(paths(one), ['src/app.ts'])
  assert.equal(one.total, 1)
})

test('find intersects a fuzzy pattern with a glob, and a listing with a glob', async () => {
  // `src` fuzzily matches every file under src plus docs/guide.md; only one of them is a .txt.
  const fuzzy = await index.find({ pattern: 'src', glob: '**/*.txt' }, cwd)
  assert.deepEqual(paths(fuzzy), ['src/window.txt'])
  assert.equal(fuzzy.total, 1)

  const listed = await index.find({ pattern: '**/*', glob: 'src/**' }, cwd)
  assert.deepEqual(paths(listed).sort(), [
    'src/app.ts',
    'src/nested/deep.ts',
    'src/window.txt',
  ])

  const none = await index.find({ pattern: '**/*.md', glob: 'src/**' }, cwd)
  assert.deepEqual(paths(none), [])
  assert.equal(none.total, 0)
})

test('grep matches literal text, a regex, and smart-case', async () => {
  const literal = await index.grep({ pattern: 'defineThing' }, cwd)
  assert.deepEqual(paths(literal), ['src/app.ts'])
  assert.equal(literal.kind, 'content')
  assert.equal(literal.items[0].line, 1)

  const regex = await index.grep({ pattern: 'define[A-Z]\\w+\\(' }, cwd)
  assert.deepEqual(paths(regex), ['src/app.ts'])

  // A regex scoped to one file hands rg that file instead of walking the tree.
  const scopedRegex = await index.grep({ pattern: 'define[A-Z]\\w+\\(', path: 'src/app.ts' }, cwd)
  assert.deepEqual(paths(scopedRegex), ['src/app.ts'])
  assert.deepEqual(
    paths(await index.grep({ pattern: 'define[A-Z]\\w+\\(', path: 'src/window.txt' }, cwd)),
    [],
  )

  // Lowercase matches either case; uppercase is case-sensitive.
  const lower = await index.grep({ pattern: 'needle' }, cwd)
  assert.deepEqual(paths(lower).sort(), ['docs/guide.md', 'root.ts', 'src/nested/deep.ts'])
  const upper = await index.grep({ pattern: 'NEEDLE' }, cwd)
  assert.deepEqual(paths(upper), ['root.ts'])
})

test('grep narrows by path and glob, carrying context and the page count', async () => {
  const scoped = await index.grep({ pattern: 'needle', path: 'src' }, cwd)
  assert.deepEqual(paths(scoped), ['src/nested/deep.ts'])

  const filtered = await index.grep({ pattern: 'handler', glob: '**/*.ts' }, cwd)
  assert.deepEqual(paths(filtered), ['src/app.ts'])

  const [match] = (await index.grep({ pattern: 'target', path: 'src/window.txt' }, cwd)).items
  assert.equal(match.text, 'target')
  assert.deepEqual(match.before, ['alpha'])
  assert.deepEqual(match.after, ['omega'])

  const page = await index.grep({ pattern: 'needle', limit: 1 }, cwd)
  assert.equal(page.items.length, 1)
  assert.equal(page.more, 1)
})

test('a search outside the working directory indexes it and reports absolute paths', async () => {
  const found = await index.find({ pattern: '*.ts' }, external)
  assert.deepEqual(paths(found).map((path) => join(external, path)), [join(external, 'other.ts')])

  const outside = await index.grep({ pattern: 'external needle', path: external }, cwd)
  assert.deepEqual(paths(outside), [join(external, 'other.ts')])
})

test('a path that does not exist fails instead of searching elsewhere', async () => {
  await assert.rejects(index.grep({ pattern: 'needle', path: 'nope' }, cwd), /Path not found: nope/)
})

test('a named file the index skips is reported, not searched to an empty result', async () => {
  await assert.rejects(
    index.grep({ pattern: 'needle', path: 'hidden.txt' }, cwd),
    /hidden\.txt is not in the search index/,
  )
})

test('a directory the index skips is reported, not searched to an empty result', async () => {
  await assert.rejects(
    index.grep({ pattern: 'needle', path: 'ignored' }, cwd),
    /ignored is not in the search index, so nothing under it is searched/,
  )
  await assert.rejects(
    index.find({ pattern: '**/*.ts', path: 'ignored' }, cwd),
    /ignored is not in the search index/,
  )
})

test('a searched directory with no match still reports an empty result', async () => {
  const content = await index.grep({ pattern: 'absent-token', path: 'src' }, cwd)
  assert.deepEqual(paths(content), [])
  assert.equal(content.total, 0)
  const files = await index.find({ pattern: '**/*.md', path: 'src' }, cwd)
  assert.deepEqual(paths(files), [])
  assert.equal(files.total, 0)
})

test('a directory empty on disk reports no files instead of an unsearched scope', async () => {
  const found = await index.find({ pattern: '**/*', path: 'empty' }, cwd)
  assert.deepEqual(paths(found), [])
  assert.equal(found.total, 0)
})

test('both tools run over the working directory through their tool calls', async () => {
  const extension = fff({ projectRoot: cwd, onClose: () => {} })
  assert.equal(extension.name, 'fff')
  assert.deepEqual(
    extension.tools!.map((tool) => tool.name),
    ['grep', 'find'],
  )
  const call = async (name: string, args: Record<string, unknown>) =>
    (await extension.tools!.find((tool) => tool.name === name)!.execute(args as never, {
      env: { cwd },
      details: async () => {},
    } as never, {} as never)) as unknown as { output: { text: string }[] }

  const grepped = await call('grep', { pattern: 'needle' })
  assert.match(grepped.output[0].text, /^Showing 3 matches:/)
  const found = await call('find', { pattern: '**/*.ts' })
  assert.match(found.output[0].text, /^Found 3 files:/)
})
