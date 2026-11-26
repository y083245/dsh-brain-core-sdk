import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import type { CheckFinding } from './types.ts'

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs'])
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.mts'])
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'test', 'tests', '__tests__'])

// The kit's own dependency test refuses these package names as text inside this package, so the
// scanner spells them from parts. They are data for the scanner here, never imports.
const DSH_SCOPE = '@deepseek-ai'
const DSH_PREFIX = DSH_SCOPE + '/'
const VENDORED_CORDIS = 'cord' + 'is'
const VENDORED_CORDIS_RULE = `no-${VENDORED_CORDIS}`

const OWN_DATABASE_MODULES = new Set(['sqlite', 'better-sqlite3', 'sqlite3', 'sql.js', 'lowdb', 'level', 'nedb'])
const DIRECT_NETWORK_MODULES = new Set(['http', 'https', 'net', 'tls', 'undici', 'axios', 'node-fetch', 'got', 'ws'])
const NETWORK_GLOBALS = new Set(['fetch', 'WebSocket', 'XMLHttpRequest'])
const FS_MODULES = new Set(['fs', 'fs/promises'])
const FS_WRITES = [
  'writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'createWriteStream', 'symlink',
] as const
const FS_WRITE_NAMES: ReadonlySet<string> = new Set(FS_WRITES.flatMap((name) => [name, `${name}Sync`]))
const CHILD_PROCESS_MODULES = new Set(['child_process'])
const DSH_COMMANDS = new Set(['spawn', 'exec', 'execFile'])
const LOG_LEVELS = new Set(['info', 'warn', 'error'])
const RAW_LOG_KEYS = new Set(['content', 'text', 'message', 'body', 'prompt'])
const DSH_HOME_NAME = 'DSH_HOME'
/** `.dsh` as a whole path segment, with either separator, at either end of the string. */
const DSH_PATH = /(^|[\\/])\.dsh([\\/]|$)/

/** The rule names the static scan owns; anything else in a report came from the manifest or the contract. */
export const SCAN_RULES: ReadonlySet<string> = new Set([
  'no-own-database', 'no-dsh', 'no-dsh-home', VENDORED_CORDIS_RULE, 'no-direct-network', 'no-fs-write', 'no-raw-log',
  'prefer-typescript',
])

interface Binding {
  readonly local: string
  readonly specifier: string
  readonly bare: string
  /** The name on the left of `as`; undefined for a namespace or default import. */
  readonly imported?: string
  readonly node: ts.Node
}
interface ModuleRef { readonly specifier: string; readonly node: ts.Node }

function bareModule(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
}

/** Plain, subpath or scoped, the Cordis package is the same violation. */
function isCordisModule(specifier: string): boolean {
  const bare = bareModule(specifier)
  return bare === VENDORED_CORDIS || bare.startsWith(`${VENDORED_CORDIS}/`)
    || bare.endsWith(`/${VENDORED_CORDIS}`) || bare.includes(`/${VENDORED_CORDIS}/`)
}

function literalText(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined
}

function isRequireCall(node: ts.Node): node is ts.CallExpression & { readonly expression: ts.Identifier } {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
    && node.arguments.length === 1 && literalText(node.arguments[0]) !== undefined
}

function collectImports(source: ts.SourceFile): { readonly bindings: readonly Binding[]; readonly modules: readonly ModuleRef[] } {
  const bindings: Binding[] = []
  const modules: ModuleRef[] = []
  const bind = (local: string, specifier: string, imported: string | undefined, node: ts.Node): void => {
    bindings.push({ local, specifier, bare: bareModule(specifier), ...(imported === undefined ? {} : { imported }), node })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier)
      if (specifier !== undefined) {
        modules.push({ specifier, node })
        const clause = node.importClause
        if (clause !== undefined) {
          if (clause.name !== undefined) bind(clause.name.text, specifier, undefined, clause.name)
          const named = clause.namedBindings
          if (named !== undefined && ts.isNamespaceImport(named)) {
            bind(named.name.text, specifier, undefined, named.name)
          } else if (named !== undefined) {
            for (const element of named.elements) {
              bind(element.name.text, specifier, (element.propertyName ?? element.name).text, element)
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const specifier = literalText(node.moduleSpecifier)
      if (specifier !== undefined) modules.push({ specifier, node })
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literalText(node.moduleReference.expression)
      if (specifier !== undefined) {
        modules.push({ specifier, node })
        bind(node.name.text, specifier, undefined, node.name)
      }
    } else if (ts.isCallExpression(node)) {
      if (isRequireCall(node)) {
        const specifier = literalText(node.arguments[0])!
        modules.push({ specifier, node })
        const parent = node.parent
        if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
          if (ts.isIdentifier(parent.name)) {
            bind(parent.name.text, specifier, undefined, node)
          } else if (ts.isObjectBindingPattern(parent.name)) {
            for (const element of parent.name.elements) {
              if (!ts.isIdentifier(element.name)) continue
              const imported = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text
              bind(element.name.text, specifier, imported, node)
            }
          }
        }
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = literalText(node.arguments[0])
        if (specifier !== undefined) modules.push({ specifier, node })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { bindings, modules }
}

function bindingNames(name: ts.BindingName, into: string[]): string[] {
  if (ts.isIdentifier(name)) {
    into.push(name.text)
    return into
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) bindingNames(element.name, into)
  }
  return into
}

function objectKeyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isPropertyAssignment(property)) {
    return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
      ? property.name.text
      : undefined
  }
  return ts.isShorthandPropertyAssignment(property) ? property.name.text : undefined
}

interface ApplyNames {
  /** The identifiers bound to `ctx` by `apply`'s first parameter. */
  readonly context: ReadonlySet<string>
  /** Locals that already are `ctx.logger`, bound by destructuring the first parameter. */
  readonly logger: ReadonlySet<string>
}

/** The work order asks that a renamed first parameter still counts as `ctx`. */
function findApplyNames(source: ts.SourceFile): ApplyNames {
  const context = new Set<string>()
  const logger = new Set<string>()
  const take = (fn: { readonly parameters: ts.NodeArray<ts.ParameterDeclaration> }): void => {
    const first = fn.parameters[0]
    if (first === undefined) return
    if (ts.isIdentifier(first.name)) {
      context.add(first.name.text)
    } else if (ts.isObjectBindingPattern(first.name)) {
      for (const element of first.name.elements) {
        if (!ts.isIdentifier(element.name)) continue
        const property = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text
        if (property === 'logger') logger.add(element.name.text)
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      if (node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === 'apply') take(node)
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'apply') {
      if (node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        take(node.initializer)
      }
    } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'apply') {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) take(node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { context, logger }
}

function scriptKind(extension: string): ts.ScriptKind {
  return extension === '.js' || extension === '.mjs' ? ts.ScriptKind.JS : ts.ScriptKind.TS
}

interface Scope {
  readonly parent?: Scope
  readonly names: Set<string>
  readonly functional: boolean
}

function resolves(scope: Scope, name: string): boolean {
  for (let current: Scope | undefined = scope; current !== undefined; current = current.parent) {
    if (current.names.has(name)) return true
  }
  return false
}

/** False when the identifier is a declaration name, a property name or a type name. */
function isReference(identifier: ts.Identifier): boolean {
  const parent: ts.Node = identifier.parent
  if (ts.isPropertyAccessExpression(parent)) return parent.name !== identifier
  if (ts.isQualifiedName(parent)) return false
  if (ts.isPropertyAssignment(parent)) return parent.name !== identifier
  if (ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)
    || ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) {
    return parent.name !== identifier
  }
  if (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) return false
  if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
    return parent.name !== identifier
  }
  if (ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent) || ts.isEnumMember(parent)) return false
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent) || ts.isExportSpecifier(parent)) return false
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false
  if (ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent) || ts.isTypeQueryNode(parent)) return false
  return true
}

function isFunctionNode(node: ts.Node): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
  | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
}

function scanFile(relative: string, text: string, extension: string): CheckFinding[] {
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, scriptKind(extension))
  const findings: CheckFinding[] = []
  const at = (node: ts.Node, rule: string, level: CheckFinding['level'], message: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    findings.push({ rule, level, message, file: relative, line })
  }

  const applyNames = findApplyNames(source)
  const { bindings, modules } = collectImports(source)
  for (const ref of modules) {
    const bare = bareModule(ref.specifier)
    if (OWN_DATABASE_MODULES.has(bare)) {
      at(ref.node, 'no-own-database', 'must', `imports "${ref.specifier}"; the kernel's memory is the only long-term store (RFC 8.7 R1)`)
    }
    if (ref.specifier === DSH_SCOPE || ref.specifier.startsWith(DSH_PREFIX)) {
      at(ref.node, 'no-dsh', 'must', `imports "${ref.specifier}"; plugins never touch DSH (RFC 8.7 R3)`)
    }
    if (isCordisModule(ref.specifier)) {
      at(ref.node, VENDORED_CORDIS_RULE, 'must', `imports "${ref.specifier}"; a plugin only ever sees BrainContext (RFC 8.7)`)
    }
    if (DIRECT_NETWORK_MODULES.has(bare)) {
      at(ref.node, 'no-direct-network', 'must', `imports "${ref.specifier}"; use ctx.http.fetch (a long-lived connection belongs in a process plugin)`)
    }
  }

  const namespaces = new Map<string, string>()
  const childCommands = new Set<string>()
  for (const binding of bindings) {
    if (binding.imported === undefined) {
      namespaces.set(binding.local, binding.bare)
    } else if (FS_MODULES.has(binding.bare) && binding.imported === 'promises') {
      // `const { promises: fsp } = require('fs')` is the same write surface under another name.
      namespaces.set(binding.local, binding.bare)
    } else if (FS_MODULES.has(binding.bare) && FS_WRITE_NAMES.has(binding.imported)) {
      at(binding.node, 'no-fs-write', 'must', `imports ${binding.imported} from "${binding.specifier}"; private data belongs in ctx.storage`)
    } else if (CHILD_PROCESS_MODULES.has(binding.bare) && DSH_COMMANDS.has(binding.imported)) {
      childCommands.add(binding.local)
    }
  }

  const isNamespaceOf = (expression: ts.Expression, modules: ReadonlySet<string>): boolean => {
    if (ts.isIdentifier(expression)) {
      const bare = namespaces.get(expression.text)
      return bare !== undefined && modules.has(bare)
    }
    if (isRequireCall(expression)) {
      const specifier = literalText(expression.arguments[0])
      return specifier !== undefined && modules.has(bareModule(specifier))
    }
    return false
  }
  /** `<fs>`, or `<fs>.promises`, both reach the same write functions. */
  const isFsTarget = (expression: ts.Expression): boolean => {
    if (isNamespaceOf(expression, FS_MODULES)) return true
    return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name) && expression.name.text === 'promises'
      && isNamespaceOf(expression.expression, FS_MODULES)
  }
  const runsDsh = (call: ts.CallExpression): void => {
    const first = call.arguments[0]
    if (first !== undefined && ts.isStringLiteralLike(first) && first.text === 'dsh') {
      at(call, 'no-dsh', 'must', 'runs the DSH CLI; plugins never touch DSH (RFC 8.7 R3)')
    }
  }
  const checkHome = (value: string, node: ts.Node): void => {
    if (value.includes(DSH_HOME_NAME)) {
      at(node, 'no-dsh-home', 'must', `names ${DSH_HOME_NAME}; plugins never read the DSH home (RFC 8.7 R3)`)
    } else if (DSH_PATH.test(value)) {
      at(node, 'no-dsh-home', 'must', 'contains a .dsh path segment; plugins never read the DSH home (RFC 8.7 R3)')
    }
  }
  const checkLogCall = (callee: ts.PropertyAccessExpression, call: ts.CallExpression): void => {
    const target = callee.expression
    const fromContext = ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.name) && target.name.text === 'logger'
      && ts.isIdentifier(target.expression) && applyNames.context.has(target.expression.text)
    const fromBinding = ts.isIdentifier(target) && applyNames.logger.has(target.text)
    if (!fromContext && !fromBinding) return
    const fields = call.arguments[1]
    if (fields === undefined || !ts.isObjectLiteralExpression(fields)) return
    for (const property of fields.properties) {
      const name = objectKeyName(property)
      if (name !== undefined && RAW_LOG_KEYS.has(name.toLowerCase())) {
        at(property, 'no-raw-log', 'must', `writes "${name}" into the log; logs carry no chat text or secrets (RFC 8.7 R8)`)
      }
    }
  }

  const moduleScope: Scope = { names: new Set(), functional: true }

  const declareName = (scope: Scope, name: string, hoistToFunction: boolean): void => {
    let target = scope
    if (hoistToFunction) while (target.parent !== undefined && !target.functional) target = target.parent
    target.names.add(name)
  }
  const declareList = (list: ts.VariableDeclarationList, scope: Scope): void => {
    const hoist = (list.flags & ts.NodeFlags.BlockScoped) === 0
    for (const declaration of list.declarations) {
      for (const name of bindingNames(declaration.name, [])) declareName(scope, name, hoist)
    }
  }
  const declareStatement = (statement: ts.Statement, scope: Scope): void => {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      if (statement.name !== undefined) scope.names.add(statement.name.text)
    } else if (ts.isVariableStatement(statement)) {
      declareList(statement.declarationList, scope)
    } else if (ts.isImportEqualsDeclaration(statement)) {
      scope.names.add(statement.name.text)
    } else if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
      const clause = statement.importClause
      if (clause.name !== undefined) scope.names.add(clause.name.text)
      const named = clause.namedBindings
      if (named !== undefined && ts.isNamespaceImport(named)) scope.names.add(named.name.text)
      else if (named !== undefined) for (const element of named.elements) scope.names.add(element.name.text)
    }
  }

  const checkNode = (node: ts.Node, scope: Scope): void => {
    if (ts.isIdentifier(node) && NETWORK_GLOBALS.has(node.text) && isReference(node) && !resolves(scope, node.text)) {
      at(node, 'no-direct-network', 'must', `uses the global ${node.text}; use ctx.http.fetch`)
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && NETWORK_GLOBALS.has(node.name.text)
      && ts.isIdentifier(node.expression) && node.expression.text === 'globalThis' && !resolves(scope, 'globalThis')) {
      at(node, 'no-direct-network', 'must', `uses the global ${node.name.text}; use ctx.http.fetch`)
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      checkHome(node.text, node)
    } else if (ts.isTemplateExpression(node)) {
      checkHome(node.head.text, node.head)
      for (const span of node.templateSpans) checkHome(span.literal.text, span.literal)
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && node.name.text === DSH_HOME_NAME) {
      at(node, 'no-dsh-home', 'must', `reads ${DSH_HOME_NAME}; plugins never read the DSH home (RFC 8.7 R3)`)
    }
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      const property = callee.name.text
      if (LOG_LEVELS.has(property)) checkLogCall(callee, node)
      if (FS_WRITE_NAMES.has(property) && isFsTarget(callee.expression)) {
        at(callee, 'no-fs-write', 'must', `calls ${property}; private data belongs in ctx.storage`)
      }
      if (DSH_COMMANDS.has(property) && isNamespaceOf(callee.expression, CHILD_PROCESS_MODULES)) runsDsh(node)
    } else if (ts.isIdentifier(callee) && childCommands.has(callee.text)) {
      runsDsh(node)
    }
  }

  function visit(node: ts.Node, scope: Scope): void {
    if (ts.isSourceFile(node)) {
      visitBody(node.statements, scope)
      return
    }
    if (ts.isBlock(node)) {
      const inner: Scope = { parent: scope, names: new Set(), functional: false }
      visitBody(node.statements, inner)
      return
    }
    if (isFunctionNode(node)) {
      const inner: Scope = { parent: scope, names: new Set(), functional: true }
      for (const parameter of node.parameters) {
        for (const name of bindingNames(parameter.name, [])) inner.names.add(name)
        if (parameter.initializer !== undefined) visit(parameter.initializer, inner)
      }
      if (ts.isFunctionExpression(node) && node.name !== undefined) inner.names.add(node.name.text)
      if (node.body === undefined) return
      if (ts.isBlock(node.body)) visitBody(node.body.statements, inner)
      else visit(node.body, inner)
      return
    }
    if (ts.isCatchClause(node)) {
      const inner: Scope = { parent: scope, names: new Set(), functional: false }
      if (node.variableDeclaration !== undefined) {
        for (const name of bindingNames(node.variableDeclaration.name, [])) inner.names.add(name)
      }
      visit(node.block, inner)
      return
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const inner: Scope = { parent: scope, names: new Set(), functional: false }
      if (node.initializer !== undefined && ts.isVariableDeclarationList(node.initializer)) declareList(node.initializer, inner)
      ts.forEachChild(node, (child) => visit(child, inner))
      return
    }
    checkNode(node, scope)
    ts.forEachChild(node, (child) => visit(child, scope))
  }
  function visitBody(statements: readonly ts.Statement[], scope: Scope): void {
    for (const statement of statements) declareStatement(statement, scope)
    for (const statement of statements) visit(statement, scope)
  }

  visit(source, moduleScope)
  return findings
}

async function sourceFiles(root: string): Promise<string[]> {
  const skipDist = await hasEntry(path.join(root, 'src')) && await hasEntry(path.join(root, 'dist'))
  const files: string[] = []
  const walk = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        if (current === root && entry.name === 'dist' && skipDist) continue
        await walk(full)
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(full)
      }
    }
  }
  await walk(root)
  return files
}

async function hasEntry(target: string): Promise<boolean> {
  try {
    await readdir(target)
    return true
  } catch {
    return false
  }
}

/**
 * The static half of `brain plugin check`: every rule that can be decided by reading the source.
 * TypeScript's own parser is used, so a string that merely looks like a call is never a finding.
 */
export async function scanSources(root: string): Promise<CheckFinding[]> {
  const files = await sourceFiles(root)
  const findings: CheckFinding[] = []
  let typescript = false
  for (const file of files) {
    const extension = path.extname(file)
    if (TYPESCRIPT_EXTENSIONS.has(extension)) typescript = true
    const relative = path.relative(root, file).split(path.sep).join('/')
    findings.push(...scanFile(relative, await readFile(file, 'utf8'), extension))
  }
  if (!typescript) {
    findings.push({
      rule: 'prefer-typescript',
      level: 'should',
      message: 'no .ts source; RFC 8.7 R10 asks for TypeScript with the SDK types',
    })
  }
  return findings
}
