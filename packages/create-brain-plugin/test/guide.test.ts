import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { PACKAGE_DIR, REPO_DIR } from './helpers.ts'

const GUIDE_DIR = path.join(REPO_DIR, 'docs', 'plugin-guide')
const guideOptions = { skip: existsSync(path.join(GUIDE_DIR, 'README.md')) ? false : 'Local plugin guide is absent' }

const PAGES = [
  'README.md', 'kinds.md', 'manifest.md', 'permissions.md', 'tools.md',
  'testing.md', 'process-plugins.md', 'mcp.md', 'rules.md', 'api.md',
]

/** Only fenced blocks tagged `ts` are examples meant to compile; JSON and shell blocks are data. */
function typescriptBlocks(markdown: string): string[] {
  const blocks: string[] = []
  for (const match of markdown.replace(/\r\n/g, '\n').matchAll(/```ts\n([\s\S]*?)```/g)) blocks.push(match[1]!)
  return blocks
}

test('example extraction does not depend on the host line ending', () => {
  assert.deepEqual(typescriptBlocks('```ts\r\nconst answer = 42\r\n```\r\n'), ['const answer = 42\n'])
})

test('the guide has every promised page', guideOptions, async () => {
  for (const page of PAGES) {
    const text = await readFile(path.join(GUIDE_DIR, page), 'utf8')
    assert.ok(text.trim().length > 200, `${page} looks empty`)
  }
})

test('every TypeScript example in the guide compiles', guideOptions, async (t) => {
  const markdown = await readdir(GUIDE_DIR)
  const blocks: { readonly file: string; readonly code: string }[] = []
  for (const name of markdown.filter((entry) => entry.endsWith('.md')).sort()) {
    const text = await readFile(path.join(GUIDE_DIR, name), 'utf8')
    typescriptBlocks(text).forEach((code, index) => {
      blocks.push({ file: `${name}#${index + 1}`, code })
    })
  }
  assert.ok(blocks.length >= 5, `expected runnable examples, found ${blocks.length}`)

  // Inside the package so `@brain-core/sdk` and `@brain-core/testkit` resolve like a plugin's own code.
  const root = await mkdtemp(path.join(PACKAGE_DIR, '.guide-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })

  const files: string[] = []
  for (const [index, block] of blocks.entries()) {
    const file = path.join(root, `block-${index + 1}.ts`)
    await writeFile(file, block.code)
    files.push(file)
  }

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    types: ['node'],
  }
  const program = ts.createProgram(files, options)
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) =>
    diagnostic.file !== undefined && path.resolve(diagnostic.file.fileName).startsWith(`${root}${path.sep}`))
  const messages = diagnostics.map((diagnostic) => {
    const file = diagnostic.file!
    const position = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
    const label = blocks[files.indexOf(path.resolve(file.fileName))]?.file ?? path.basename(file.fileName)
    return `${label}:${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
  })
  assert.deepEqual(messages, [])
})
