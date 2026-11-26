import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import subsetFont from 'subset-font'

const MAX_NOTO_WEIGHT_BYTES = 180 * 1024
const MAX_TOTAL_WOFF2_BYTES = 600 * 1024

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(scriptsDir, '..')
const srcDir = path.join(webDir, 'src')
const fontsDir = path.join(webDir, 'public', 'fonts')
const indexHtmlPath = path.join(webDir, 'index.html')

/**
 * Fixed Chinese display & UI copy from the INKTIDE design spec (Sections 2-8).
 */
const SPEC_FIXED_CHINESE = [
  '庭语忆心印脉账设落款墨潮墨阶墨痕墨谱卷潮印谱契约遗忘卸载准许复位合并拆分',
  '无痕未印无事未通失联讫准拒今成慎误知过隔通',
  '小鲸鱼小满记忆人物审计总览对话插件设置权限巩固提案花费互联状态',
  '夜墨宣纸静墨活墨圆相笔锋手卷墨丝砚待批已批已拒编辑标过时重启隔离',
  '模型密钥角色卡界面声音画质动效跟随系统已归档未选择确认取消算了重试发送送等',
  '开印改写淡墨中墨浓墨焦墨朱印朱砂藤黄石绿石青胭脂新墨褪墨无价',
  '检索证据依据通道版本启用停用升级安装预算价格配额问选写自动静止完整减少开关',
  '令牌只驻留内存刷新即清请输入访问',
].join('')

/**
 * Top 500 most common modern Simplified Chinese characters as headroom for display typography.
 */
const TOP_500_COMMON_CHINESE =
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严'

const ASCII_PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')

const UI_SYMBOLS_AND_PUNCT =
  '·—–…「」『』【】（）《》“”‘’、，。：；？！¥×±°→←↑↓⇄›⌘◐●○■◆▲▾✕⋯∿≈▌◯§•€£'

const LATIN_DISPLAY_TEXT = `${ASCII_PRINTABLE}·—–…¥×±°→←›◆•“”‘’§€£`
const MONO_TEXT = `${ASCII_PRINTABLE}${UI_SYMBOLS_AND_PUNCT}`

const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g

function dedupeSortedChars(text) {
  const set = new Set()
  for (const ch of text) {
    set.add(ch)
  }
  return [...set].sort((a, b) => a.codePointAt(0) - b.codePointAt(0)).join('')
}

async function collectFiles(dir, exts) {
  const results = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(full, exts)))
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(full)
    }
  }
  return results.sort()
}

/**
 * Strips single-line and block comments so comment-only Han characters don't bloat subsets.
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/**
 * Scans `apps/console/web/src/**\/*.tsx` and `index.html` for UI Chinese characters.
 */
const DISPLAY_TAG_PROP_RE =
  /<(?:PageHeader|EmptyState|Covenant|HoldToStamp)\b[^>]*?\b(?:title|label)\s*=\s*["']([^"']+)["']/g
const DISPLAY_BLOCK_RE =
  /(?:title-display|font-display-cjk)[\s\S]{0,240}?>([^<{]+)</g
const ROUTE_TITLE_GLYPH_RE = /\b(?:title|glyph)\s*:\s*["']([^"']+)["']/g

async function scanSourceChineseChars() {
  const srcFiles = (await collectFiles(srcDir, ['.tsx', '.ts'])).filter((file) => {
    const normalized = file.replaceAll('\\', '/')
    return !normalized.includes('/src/dev/')
  })
  const found = new Set()

  const addChars = (str) => {
    const matches = str.match(CJK_CHAR_RE)
    if (matches !== null) {
      for (const ch of matches) {
        found.add(ch)
      }
    }
  }

  try {
    const htmlRaw = await readFile(indexHtmlPath, 'utf8')
    addChars(htmlRaw)
  } catch {
    // Ignore missing index.html
  }

  for (const file of srcFiles) {
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const cleaned = stripComments(raw)
    const normalized = file.replaceAll('\\', '/')

    if (normalized.endsWith('/src/shell/routes.ts')) {
      for (const m of cleaned.matchAll(ROUTE_TITLE_GLYPH_RE)) {
        addChars(m[1])
      }
      continue
    }

    for (const m of cleaned.matchAll(DISPLAY_TAG_PROP_RE)) {
      addChars(m[1])
    }
    for (const m of cleaned.matchAll(DISPLAY_BLOCK_RE)) {
      addChars(m[1])
    }
  }
  return [...found].sort((a, b) => a.codePointAt(0) - b.codePointAt(0)).join('')
}

function normalizeLfBuffer(buf) {
  const out = []
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) {
      continue
    }
    out.push(buf[i])
  }
  return Buffer.from(out)
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function parseArg(flag) {
  const idx = process.argv.indexOf(flag)
  if (idx === -1) return undefined
  return process.argv[idx + 1]
}

/**
 * Extracts OpenType `name` version string and `fvar` axis tags + ranges from a TTF/OTF buffer
 * for verification & manifest provenance.
 */
function inspectSfntMetadata(buf) {
  const numTables = buf.readUInt16BE(4)
  let fvarOffset = 0
  let nameOffset = 0

  for (let i = 0; i < numTables; i++) {
    const recOff = 12 + i * 16
    const tag = buf.toString('ascii', recOff, recOff + 4)
    const offset = buf.readUInt32BE(recOff + 8)
    if (tag === 'fvar') fvarOffset = offset
    if (tag === 'name') nameOffset = offset
  }

  const axes = []
  if (fvarOffset > 0) {
    const axesArrayOffset = buf.readUInt16BE(fvarOffset + 4)
    const axisCount = buf.readUInt16BE(fvarOffset + 8)
    const axisSize = buf.readUInt16BE(fvarOffset + 10)
    for (let i = 0; i < axisCount; i++) {
      const off = fvarOffset + axesArrayOffset + i * axisSize
      const tag = buf.toString('ascii', off, off + 4)
      const minValue = buf.readInt32BE(off + 4) / 65536
      const defaultValue = buf.readInt32BE(off + 8) / 65536
      const maxValue = buf.readInt32BE(off + 12) / 65536
      axes.push({ tag, min: minValue, default: defaultValue, max: maxValue })
    }
  }

  let version = 'unknown'
  let fullName = 'unknown'
  if (nameOffset > 0) {
    const count = buf.readUInt16BE(nameOffset + 2)
    const stringOffset = buf.readUInt16BE(nameOffset + 4)
    for (let i = 0; i < count; i++) {
      const rec = nameOffset + 6 + i * 12
      const platformId = buf.readUInt16BE(rec)
      const nameId = buf.readUInt16BE(rec + 6)
      const length = buf.readUInt16BE(rec + 8)
      const strOff = buf.readUInt16BE(rec + 10)
      if ((nameId === 4 || nameId === 5) && (platformId === 3 || platformId === 1)) {
        const slice = buf.subarray(nameOffset + stringOffset + strOff, nameOffset + stringOffset + strOff + length)
        let decoded
        if (platformId === 3) {
          const chars = []
          for (let j = 0; j + 1 < slice.length; j += 2) {
            chars.push(String.fromCharCode(slice.readUInt16BE(j)))
          }
          decoded = chars.join('')
        } else {
          decoded = slice.toString('latin1')
        }
        if (nameId === 4 && fullName === 'unknown') fullName = decoded
        if (nameId === 5 && version === 'unknown') version = decoded
      }
    }
  }

  return { fullName, version, axes }
}

function buildOflText(sourcesMeta, oflBody) {
  const header = [
    'SIL Open Font License (OFL) 1.1 — Bundled Offline Font Provenance for Brain Core Console (INKTIDE)',
    '==================================================================================================',
    '',
    'This directory contains offline subsets of three SIL OFL-1.1 open-source fonts:',
    '',
    `1. Noto Serif SC (Bold 700 & Black/Heavy 900)`,
    `   - Files: noto-serif-sc-700.woff2, noto-serif-sc-900.woff2`,
    `   - Source: https://github.com/notofonts/noto-cjk (Serif/OTF/SimplifiedChinese)`,
    `   - Font names: ${sourcesMeta.noto700.fullName} (${sourcesMeta.noto700.version}); ${sourcesMeta.noto900.fullName} (${sourcesMeta.noto900.version})`,
    `   - Copyright: Copyright 2014-2023 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source' / Noto Project Authors`,
    `   - License: SIL Open Font License, Version 1.1 (OFL-1.1)`,
    '',
    `2. Fraunces (Variable Font: wght 100-900, opsz 9-144, SOFT 0-100, WONK 0-1)`,
    `   - File: fraunces-variable.woff2`,
    `   - Source: https://github.com/google/fonts/tree/main/ofl/fraunces (upstream: https://github.com/undercasetype/Fraunces)`,
    `   - Font name: ${sourcesMeta.fraunces.fullName} (${sourcesMeta.fraunces.version})`,
    `   - Copyright: Copyright 2020 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces)`,
    `   - License: SIL Open Font License, Version 1.1 (OFL-1.1)`,
    '',
    `3. JetBrains Mono (Variable Font: wght 100-800)`,
    `   - File: jetbrains-mono-variable.woff2`,
    `   - Source: https://github.com/google/fonts/tree/main/ofl/jetbrainsmono (upstream: https://github.com/JetBrains/JetBrainsMono)`,
    `   - Font name: ${sourcesMeta.jetbrains.fullName} (${sourcesMeta.jetbrains.version})`,
    `   - Copyright: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)`,
    `   - License: SIL Open Font License, Version 1.1 (OFL-1.1)`,
    '',
    'CSS @font-face family aliases ("Noto Serif SC Inktide", "Fraunces Inktide", "JetBrains Mono Inktide")',
    'are used in styles/fonts.css to ensure offline subset isolation without colliding with system fonts.',
    '',
    '--------------------------------------------------------------------------------------------------',
    '',
  ].join('\n')

  return `${header}${oflBody.trim()}\n`
}

async function runCheck() {
  const manifestPath = path.join(fontsDir, 'manifest.json')
  let manifestRaw
  try {
    manifestRaw = await readFile(manifestPath, 'utf8')
  } catch {
    process.stderr.write(`Missing font manifest: ${manifestPath}\n`)
    process.exit(1)
  }

  const manifest = JSON.parse(manifestRaw)
  let totalWoff2Bytes = 0

  for (const [filename, meta] of Object.entries(manifest.files)) {
    const filePath = path.join(fontsDir, filename)
    let buf
    try {
      buf = await readFile(filePath)
    } catch {
      process.stderr.write(`Missing font asset: ${filePath}\n`)
      process.exit(1)
    }

    const actualHash = sha256Hex(buf)
    if (actualHash !== meta.sha256) {
      process.stderr.write(`SHA-256 mismatch for ${filename}: expected ${meta.sha256}, got ${actualHash}\n`)
      process.exit(1)
    }
    if (buf.byteLength !== meta.bytes) {
      process.stderr.write(`Size mismatch for ${filename}: expected ${String(meta.bytes)}, got ${String(buf.byteLength)}\n`)
      process.exit(1)
    }

    if (filename.endsWith('.woff2')) {
      if (buf.toString('ascii', 0, 4) !== 'wOF2') {
        process.stderr.write(`Invalid WOFF2 magic header in ${filename}\n`)
        process.exit(1)
      }
      totalWoff2Bytes += buf.byteLength
      if (filename.startsWith('noto-serif-sc-') && buf.byteLength > MAX_NOTO_WEIGHT_BYTES) {
        process.stderr.write(
          `Noto weight budget exceeded for ${filename}: ${String(buf.byteLength)} B > ${String(MAX_NOTO_WEIGHT_BYTES)} B\n`,
        )
        process.exit(1)
      }
    }
  }

  if (totalWoff2Bytes > MAX_TOTAL_WOFF2_BYTES) {
    process.stderr.write(
      `Total WOFF2 font budget exceeded: ${String(totalWoff2Bytes)} B > ${String(MAX_TOTAL_WOFF2_BYTES)} B\n`,
    )
    process.exit(1)
  }

  // Verify OFL.txt exists and matches manifest
  const oflPath = path.join(fontsDir, 'OFL.txt')
  let oflBuf
  try {
    oflBuf = await readFile(oflPath)
  } catch {
    process.stderr.write(`Missing OFL.txt at ${oflPath}\n`)
    process.exit(1)
  }
  if (sha256Hex(normalizeLfBuffer(oflBuf)) !== manifest.oflSha256) {
    process.stderr.write(`OFL.txt SHA-256 mismatch against manifest.json\n`)
    process.exit(1)
  }

  // Verify all required variable axes are declared
  const frauncesAxes = new Set((manifest.files['fraunces-variable.woff2']?.axes ?? []).map((a) => a.tag))
  for (const requiredAxis of ['wght', 'opsz', 'SOFT', 'WONK']) {
    if (!frauncesAxes.has(requiredAxis)) {
      process.stderr.write(`Missing required Fraunces variable axis: ${requiredAxis}\n`)
      process.exit(1)
    }
  }
  const jbAxes = new Set((manifest.files['jetbrains-mono-variable.woff2']?.axes ?? []).map((a) => a.tag))
  if (!jbAxes.has('wght')) {
    process.stderr.write(`Missing required JetBrains Mono variable axis: wght\n`)
    process.exit(1)
  }

  // Verify all Chinese characters found in src/**/*.tsx and index.html are covered by subset
  const coveredCjk = new Set([...(manifest.coverage?.cjkChars ?? '')])
  const scannedCjk = await scanSourceChineseChars()
  const missing = []
  for (const ch of scannedCjk) {
    if (!coveredCjk.has(ch)) {
      missing.push(ch)
    }
  }
  if (missing.length > 0) {
    process.stderr.write(
      `Source UI contains ${String(missing.length)} Chinese character(s) missing from font subset: ${missing.join('')}\nRun node apps/console/web/scripts/subset-fonts.mjs --source-dir <dir> to regenerate.\n`,
    )
    process.exit(1)
  }

  process.stdout.write(
    `Fonts OK: 4 WOFF2 files verified, total ${String(totalWoff2Bytes)} B (<= ${String(MAX_TOTAL_WOFF2_BYTES)} B), ${String(coveredCjk.size)} CJK chars covered (0 missing from src).\n`,
  )
}

async function runGenerate(sourceDir) {
  const noto700Buf = await readFile(path.join(sourceDir, 'NotoSerifSC-700.otf'))
  const noto900Buf = await readFile(path.join(sourceDir, 'NotoSerifSC-900.otf'))
  const frauncesBuf = await readFile(path.join(sourceDir, 'Fraunces-Variable.ttf'))
  const jetbrainsBuf = await readFile(path.join(sourceDir, 'JetBrainsMono-Variable.ttf'))
  const oflRaw = await readFile(path.join(sourceDir, 'Fraunces-OFL.txt'), 'utf8')

  const oflStart = oflRaw.indexOf('SIL OPEN FONT LICENSE Version 1.1')
  const oflCanonicalBody = oflStart >= 0 ? oflRaw.slice(oflStart) : oflRaw

  const sourcesMeta = {
    noto700: inspectSfntMetadata(noto700Buf),
    noto900: inspectSfntMetadata(noto900Buf),
    fraunces: inspectSfntMetadata(frauncesBuf),
    jetbrains: inspectSfntMetadata(jetbrainsBuf),
  }

  const scannedCjk = await scanSourceChineseChars()
  const cjkChars = dedupeSortedChars(`${SPEC_FIXED_CHINESE}${TOP_500_COMMON_CHINESE}${scannedCjk}`)
  const notoSubsetText = dedupeSortedChars(`${cjkChars}${ASCII_PRINTABLE}${UI_SYMBOLS_AND_PUNCT}`)
  const frauncesSubsetText = dedupeSortedChars(LATIN_DISPLAY_TEXT)
  const jetbrainsSubsetText = dedupeSortedChars(MONO_TEXT)

  // Verify variable axes survive subsetting by also subsetting to truetype in memory for inspection
  const [
    noto700Woff2,
    noto900Woff2,
    frauncesWoff2,
    frauncesSfntCheck,
    jetbrainsWoff2,
    jetbrainsSfntCheck,
  ] = await Promise.all([
    subsetFont(noto700Buf, notoSubsetText, { targetFormat: 'woff2', noLayoutClosure: true }),
    subsetFont(noto900Buf, notoSubsetText, { targetFormat: 'woff2', noLayoutClosure: true }),
    subsetFont(frauncesBuf, frauncesSubsetText, { targetFormat: 'woff2' }),
    subsetFont(frauncesBuf, frauncesSubsetText, { targetFormat: 'truetype' }),
    subsetFont(jetbrainsBuf, jetbrainsSubsetText, { targetFormat: 'woff2' }),
    subsetFont(jetbrainsBuf, jetbrainsSubsetText, { targetFormat: 'truetype' }),
  ])

  const frauncesOutMeta = inspectSfntMetadata(frauncesSfntCheck)
  const jetbrainsOutMeta = inspectSfntMetadata(jetbrainsSfntCheck)

  const requiredFrauncesAxes = ['wght', 'opsz', 'SOFT', 'WONK']
  for (const tag of requiredFrauncesAxes) {
    if (!frauncesOutMeta.axes.some((a) => a.tag === tag)) {
      throw new Error(`Fraunces subset lost variable axis: ${tag}`)
    }
  }
  if (!jetbrainsOutMeta.axes.some((a) => a.tag === 'wght')) {
    throw new Error('JetBrains Mono subset lost variable axis: wght')
  }

  if (noto700Woff2.byteLength > MAX_NOTO_WEIGHT_BYTES) {
    throw new Error(`noto-serif-sc-700.woff2 exceeds 180 KB budget: ${String(noto700Woff2.byteLength)} B`)
  }
  if (noto900Woff2.byteLength > MAX_NOTO_WEIGHT_BYTES) {
    throw new Error(`noto-serif-sc-900.woff2 exceeds 180 KB budget: ${String(noto900Woff2.byteLength)} B`)
  }

  const totalWoff2Bytes =
    noto700Woff2.byteLength
    + noto900Woff2.byteLength
    + frauncesWoff2.byteLength
    + jetbrainsWoff2.byteLength

  if (totalWoff2Bytes > MAX_TOTAL_WOFF2_BYTES) {
    throw new Error(`Combined WOFF2 size exceeds 600 KB budget: ${String(totalWoff2Bytes)} B`)
  }

  const oflText = buildOflText(sourcesMeta, oflCanonicalBody)
  const oflBuf = normalizeLfBuffer(Buffer.from(oflText, 'utf8'))

  const outputs = [
    {
      name: 'noto-serif-sc-700.woff2',
      data: noto700Woff2,
      source: sourcesMeta.noto700,
      charCount: [...notoSubsetText].length,
      axes: [],
    },
    {
      name: 'noto-serif-sc-900.woff2',
      data: noto900Woff2,
      source: sourcesMeta.noto900,
      charCount: [...notoSubsetText].length,
      axes: [],
    },
    {
      name: 'fraunces-variable.woff2',
      data: frauncesWoff2,
      source: sourcesMeta.fraunces,
      charCount: [...frauncesSubsetText].length,
      axes: frauncesOutMeta.axes,
    },
    {
      name: 'jetbrains-mono-variable.woff2',
      data: jetbrainsWoff2,
      source: sourcesMeta.jetbrains,
      charCount: [...jetbrainsSubsetText].length,
      axes: jetbrainsOutMeta.axes,
    },
  ]

  const manifestFiles = {}
  for (const out of outputs) {
    manifestFiles[out.name] = {
      bytes: out.data.byteLength,
      gzipBytes: gzipSync(out.data, { level: 9 }).byteLength,
      sha256: sha256Hex(out.data),
      sourceName: out.source.fullName,
      sourceVersion: out.source.version,
      charCount: out.charCount,
      axes: out.axes,
    }
  }

  const manifest = {
    schemaVersion: 1,
    license: 'OFL-1.1',
    totalWoff2Bytes,
    oflSha256: sha256Hex(oflBuf),
    coverage: {
      cjkCount: [...cjkChars].length,
      cjkChars,
      latinDisplayCount: [...frauncesSubsetText].length,
      monoCount: [...jetbrainsSubsetText].length,
    },
    files: manifestFiles,
  }

  await mkdir(fontsDir, { recursive: true })
  for (const out of outputs) {
    await writeFile(path.join(fontsDir, out.name), out.data)
  }
  await writeFile(path.join(fontsDir, 'OFL.txt'), oflBuf)
  await writeFile(path.join(fontsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  process.stdout.write(`Generated OFL-1.1 offline font subsets in ${fontsDir}:\n`)
  for (const out of outputs) {
    const info = manifestFiles[out.name]
    const axesNote = out.axes.length > 0
      ? ` axes=[${out.axes.map((a) => `${a.tag}:${String(a.min)}..${String(a.max)}`).join(', ')}]`
      : ''
    process.stdout.write(
      `  - ${out.name}: ${String(info.bytes)} B (gzip ${String(info.gzipBytes)} B), ${String(info.charCount)} chars${axesNote}\n`,
    )
  }
  process.stdout.write(`  - Total WOFF2: ${String(totalWoff2Bytes)} B (budget <= ${String(MAX_TOTAL_WOFF2_BYTES)} B)\n`)
  process.stdout.write(`  - CJK coverage: ${String([...cjkChars].length)} unique Han characters\n`)
}

async function main() {
  if (process.argv.includes('--check')) {
    await runCheck()
    return
  }

  const sourceDir = parseArg('--source-dir')
  if (sourceDir === undefined || sourceDir === '') {
    process.stderr.write(
      'Usage:\n  node subset-fonts.mjs --check\n  node subset-fonts.mjs --source-dir <dir>\n',
    )
    process.exit(1)
  }
  await runGenerate(path.resolve(sourceDir))
}

await main()
