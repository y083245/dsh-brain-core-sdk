import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractSealGlyphs,
  generatePluginSealSvg,
  type PluginSealVariant,
} from '../../web/src/plugins/seal.ts'

const ALL_VARIANTS: readonly PluginSealVariant[] = ['auto', 'hollow', 'pending', 'failed']
const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/

function extractTextContents(svg: string): string[] {
  const matches = Array.from(svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g))
  return matches.map((m) => m[1] ?? '')
}

test('determinism: identical pluginId yields byte-for-byte identical SVG across calls and variants', () => {
  const sampleIds = ['web-reader', 'console-chat', 'echo', 'qq-bridge', 'memory.audit_v2']

  for (const id of sampleIds) {
    for (const variant of ALL_VARIANTS) {
      const first = generatePluginSealSvg(id, variant)
      const second = generatePluginSealSvg(id, variant)
      assert.equal(first, second, `cache & determinism mismatch for ${id} (${variant})`)
      assert.ok(first.startsWith('<svg '), 'must start with <svg')
      assert.ok(first.includes('viewBox="0 0 96 96"'), 'must use 96x96 viewBox')
      assert.ok(first.endsWith('</svg>'), 'must end with </svg>')
    }
  }
})

test('distinct pluginIds produce distinct SVGs', () => {
  const ids = [
    'web-reader',
    'console-chat',
    'echo',
    'qq-bridge',
    'memory-tools',
    'search.v2',
    'alpha_beta',
    'gamma-delta',
  ]
  const outputs = new Set(ids.map((id) => generatePluginSealSvg(id)))
  assert.equal(outputs.size, ids.length)
})

test('extractSealGlyphs follows Appendix D segmentation, character filter, max length 2, and fallback ◆', () => {
  assert.equal(extractSealGlyphs('web-reader'), 'WR')
  assert.equal(extractSealGlyphs('console-chat'), 'CC')
  assert.equal(extractSealGlyphs('echo'), 'E')
  assert.equal(extractSealGlyphs('a.b.c'), 'AB')
  assert.equal(extractSealGlyphs('foo_bar_baz'), 'FB')
  assert.equal(extractSealGlyphs('9lives-2'), '92')
  assert.equal(extractSealGlyphs('!skip-alpha_beta'), 'AB')
  assert.equal(extractSealGlyphs(''), '◆')
  assert.equal(extractSealGlyphs('---___...'), '◆')
  assert.equal(extractSealGlyphs('中文-插件'), '◆')
  assert.equal(extractSealGlyphs('<script>alert(1)</script>'), '◆')
})

test('rendered SVG text glyphs strictly belong to allowed set [A-Z0-9] (1-2 chars) or ◆', () => {
  const trickyIds = [
    'web-reader',
    'echo',
    '123-456',
    '',
    '---',
    '中文插件',
    '@scope/plugin',
    '<img src=x onerror=alert(1)>',
    'a-b-c-d',
  ]

  for (const id of trickyIds) {
    const svg = generatePluginSealSvg(id)
    const texts = extractTextContents(svg)
    const joined = texts.join('')
    assert.ok(
      /^(?:[A-Z0-9]{1,2}|◆)$/.test(joined),
      `unexpected glyph "${joined}" for pluginId "${id}"`,
    )
    assert.ok(!svg.includes('<script'), 'must never embed raw script tags')
    assert.ok(!svg.includes('onerror='), 'must never embed raw event handlers')
  }
})

test('auto variant produces both baiwen (白文印) and zhuwen (朱文印) styles across ids', () => {
  let baiwenCount = 0
  let zhuwenCount = 0

  for (let i = 0; i < 40; i += 1) {
    const svg = generatePluginSealSvg(`plugin-sample-${i}`, 'auto')
    if (svg.includes('data-seal-style="baiwen"')) {
      baiwenCount += 1
      assert.ok(svg.includes('fill="var(--zhusha)"'), 'baiwen frame must use zhusha fill')
      assert.ok(svg.includes('fill="var(--plate)"'), 'baiwen glyphs must use plate cutout')
    } else if (svg.includes('data-seal-style="zhuwen"')) {
      zhuwenCount += 1
      assert.ok(svg.includes('fill="var(--plate)"'), 'zhuwen frame must use plate fill')
      assert.ok(svg.includes('fill="var(--zhusha)"'), 'zhuwen glyphs must use zhusha fill')
    } else {
      assert.fail(`missing seal style marker for sample ${i}`)
    }
  }

  assert.ok(baiwenCount > 0, 'expected at least one baiwen seal')
  assert.ok(zhuwenCount > 0, 'expected at least one zhuwen seal')
})

test('hollow, pending, and failed variants match Appendix D & §8.6.1 specifications with zero bare hex', () => {
  const id = 'web-reader'

  const autoSvg = generatePluginSealSvg(id, 'auto')
  const hollowSvg = generatePluginSealSvg(id, 'hollow')
  const pendingSvg = generatePluginSealSvg(id, 'pending')
  const failedSvg = generatePluginSealSvg(id, 'failed')

  for (const svg of [autoSvg, hollowSvg, pendingSvg, failedSvg]) {
    assert.equal(HEX_COLOR_RE.test(svg), false, 'seal SVG must contain zero bare hex colors')
    assert.ok(svg.includes('var(--font-display-latin)'), 'must reference Fraunces display font var')
    assert.ok(
      svg.includes("'wght' 900,'SOFT' 0,'WONK' 1"),
      'must set Fraunces wght 900, SOFT 0, WONK 1',
    )
  }

  // Hollow: outline only, no solid fill
  assert.ok(hollowSvg.includes('fill="none" stroke="var(--zhusha)"'))
  assert.ok(!hollowSvg.includes('data-seal-chip='))

  // Pending: tenghuang dashed outline
  assert.ok(pendingSvg.includes('stroke="var(--tenghuang)"'))
  assert.ok(pendingSvg.includes('stroke-dasharray='))

  // Failed: yanzhi crack path added
  assert.ok(failedSvg.includes('data-seal-crack="true"'))
  assert.ok(failedSvg.includes('stroke="var(--yanzhi)"'))

  // Auto & failed include 14-22 small chips (r in [0.6, 2.4]) and 1 corner chip (r in [4, 7])
  const smallChips = Array.from(autoSvg.matchAll(/r="([0-9.]+)" fill="var\(--plate\)" data-seal-chip="small"/g))
  assert.ok(
    smallChips.length >= 14 && smallChips.length <= 22,
    `expected 14-22 small distress chips, got ${smallChips.length}`,
  )
  for (const m of smallChips) {
    const r = Number(m[1])
    assert.ok(r >= 0.6 && r <= 2.4, `small chip radius ${r} out of [0.6, 2.4]`)
  }

  const cornerChips = Array.from(autoSvg.matchAll(/r="([0-9.]+)" fill="var\(--plate\)" data-seal-chip="corner"/g))
  assert.equal(cornerChips.length, 1, 'expected exactly 1 corner chip')
  const cornerR = Number(cornerChips[0]?.[1])
  assert.ok(cornerR >= 4 && cornerR <= 7, `corner chip radius ${cornerR} out of [4, 7]`)

  // Frame stroke width is in [4, 6]
  const strokeMatch = autoSvg.match(/<path d="[^"]+" fill="[^"]+" stroke="var\(--zhusha\)" stroke-width="([0-9.]+)"/)
  assert.ok(strokeMatch !== null, 'frame path must be present')
  const strokeWidth = Number(strokeMatch[1])
  assert.ok(strokeWidth >= 4 && strokeWidth <= 6, `frame stroke width ${strokeWidth} out of [4, 6]`)
})
