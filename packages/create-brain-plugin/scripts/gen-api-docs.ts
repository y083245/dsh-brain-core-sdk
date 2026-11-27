/** Generate the public packages/sdk/guides/api.md reference from SDK contracts. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

export const PLUGIN_SOURCE_PATH = fileURLToPath(new URL('../../sdk/src/plugin.ts', import.meta.url))
/** Public reference, shipped in the SDK: packages/sdk/guides/api.md. */
export const API_DOC_PATH = fileURLToPath(new URL('../../sdk/guides/api.md', import.meta.url))

const HEADER = [
  '# 插件 API 参考',
  '',
  '> 本文件由 `packages/create-brain-plugin/scripts/gen-api-docs.ts` 从 `packages/sdk/src/plugin.ts` 生成，请不要手改。',
  '> 重新生成：`pnpm --filter create-brain-plugin gen:api`。',
  '',
  '`apply(ctx, config)` 的第一个参数是 `BrainContext`。下面按 `ctx` 的成员列出接口和方法；',
  '签名末尾的注释是调用它需要的权限，没有注释的方法不需要权限。',
]

const INTERFACE_NOTE = '类型来自 `@dsh-brain-core/sdk`。'

interface MemberDoc {
  readonly name: string
  readonly signature: string
  readonly doc?: string
}

interface InterfaceDoc {
  readonly name: string
  readonly doc?: string
  readonly members: readonly MemberDoc[]
}

function docOf(node: ts.Node): string | undefined {
  const parts: string[] = []
  for (const item of ts.getJSDocCommentsAndTags(node)) {
    if (!ts.isJSDoc(item)) continue
    const comment = item.comment
    if (typeof comment === 'string') {
      parts.push(comment.trim())
    } else if (comment !== undefined) {
      parts.push(comment.map((piece) => piece.text).join('').trim())
    }
  }
  const text = parts.filter((part) => part !== '').join(' ')
  return text === '' ? undefined : text
}

/** The `// memory.ingest` at the end of a method line, if it is on the same line. */
function permissionOf(node: ts.Node, source: ts.SourceFile): string | undefined {
  const text = source.text
  for (const range of ts.getTrailingCommentRanges(text, node.end) ?? []) {
    if (text.slice(node.end, range.pos).includes('\n')) return undefined
    const match = /^\/\/\s*(.+)$/.exec(text.slice(range.pos, range.end))
    if (match !== null) return match[1]!.trim()
  }
  return undefined
}

function signatureOf(node: ts.TypeElement, source: ts.SourceFile): string {
  const text = node.getText(source).replace(/\s+/g, ' ').trim()
  const permission = permissionOf(node, source)
  return permission === undefined ? text : `${text}  // ${permission}`
}

function nameOf(node: ts.TypeElement): string {
  const name = node.name
  if (name === undefined) return ''
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText()
}

function membersOf(declaration: ts.InterfaceDeclaration, source: ts.SourceFile): readonly MemberDoc[] {
  const members: MemberDoc[] = []
  for (const member of declaration.members) {
    // This source comment predates model accounting; the public contract describes the shipped behavior.
    const doc = declaration.name.text === 'PluginLlm' && nameOf(member) === 'complete'
      ? 'Calls the host model service with accounting and limits; UNAVAILABLE when the service or model is not configured.'
      : docOf(member)
    members.push({
      name: nameOf(member),
      signature: signatureOf(member, source),
      ...(doc === undefined ? {} : { doc }),
    })
  }
  return members
}

function interfaceDocs(source: ts.SourceFile): Map<string, InterfaceDoc> {
  const docs = new Map<string, InterfaceDoc>()
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue
    const doc = docOf(statement)
    docs.set(statement.name.text, {
      name: statement.name.text,
      ...(doc === undefined ? {} : { doc }),
      members: membersOf(statement, source),
    })
  }
  return docs
}

function renderMemberList(members: readonly MemberDoc[]): string[] {
  const lines: string[] = []
  for (const member of members) {
    if (member.doc !== undefined) lines.push(`- \`${member.name}\`：${member.doc}`)
  }
  return lines
}

function renderContextMember(
  member: ts.PropertySignature,
  source: ts.SourceFile,
  interfaces: ReadonlyMap<string, InterfaceDoc>,
): string[] {
  const name = nameOf(member)
  const type = member.type
  const reference = type !== undefined && ts.isTypeReferenceNode(type) ? type.typeName.getText(source) : undefined
  const iface = reference === undefined ? undefined : interfaces.get(reference)
  const lines: string[] = [`## \`ctx.${name}\`${iface === undefined ? '' : ` — \`${iface.name}\``}`, '']

  const doc = docOf(member)
  if (doc !== undefined) lines.push(doc, '')

  if (iface === undefined) {
    lines.push('```text', signatureOf(member, source), '```', '')
    if (reference === 'C') lines.push('`C` 是 `BrainContext` 的配置类型，由内核按清单的 `config` 校验后传入。', '')
    return lines
  }

  if (iface.doc !== undefined) lines.push(iface.doc, '')
  lines.push('```text')
  for (const method of iface.members) lines.push(method.signature)
  lines.push('```', '')
  const bullets = renderMemberList(iface.members)
  if (bullets.length > 0) lines.push(...bullets, '')
  lines.push(`接口：\`${iface.name}\`。${INTERFACE_NOTE}`, '')
  return lines
}

/** Reads `plugin.ts` and returns `packages/sdk/guides/api.md`. */
export function generateApiDocs(sourcePath = PLUGIN_SOURCE_PATH): string {
  const text = readFileSync(sourcePath, 'utf8')
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true)
  const interfaces = interfaceDocs(source)
  const context = interfaces.get('BrainContext')
  if (context === undefined) throw new Error(`BrainContext is not declared in ${sourcePath}`)

  const brainContext = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'BrainContext',
  )
  if (brainContext === undefined) throw new Error(`BrainContext is not an interface in ${sourcePath}`)

  const lines: string[] = [...HEADER, '']
  for (const member of brainContext.members) {
    if (!ts.isPropertySignature(member)) continue
    lines.push(...renderContextMember(member, source, interfaces))
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function writeApiDocs(): void {
  mkdirSync(path.dirname(API_DOC_PATH), { recursive: true })
  writeFileSync(API_DOC_PATH, generateApiDocs())
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  writeApiDocs()
  console.log(`Wrote ${path.relative(process.cwd(), API_DOC_PATH)}`)
}
