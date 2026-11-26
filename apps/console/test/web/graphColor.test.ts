import assert from 'node:assert/strict'
import test from 'node:test'
import { Color, LinearSRGBColorSpace } from 'three'
import { parseCssColorToHexOrRgb } from '../../web/src/memory/graph/graphRenderer.ts'

test('parseCssColorToHexOrRgb strips alpha from 8-digit and 4-digit hex colors', () => {
  assert.equal(parseCssColorToHexOrRgb('#1a15114d'), '#1a1511')
  assert.equal(parseCssColorToHexOrRgb('  #ECE4D461  '), '#ECE4D4')
  assert.equal(parseCssColorToHexOrRgb('#1a1511'), '#1a1511')
  assert.equal(parseCssColorToHexOrRgb('#123a'), '#123')
  assert.equal(parseCssColorToHexOrRgb('#123'), '#123')
})

test('parseCssColorToHexOrRgb normalizes legacy rgba and CSS Color 4 space-delimited rgb', () => {
  assert.equal(parseCssColorToHexOrRgb('rgba(26, 21, 17, 0.30)'), 'rgb(26, 21, 17)')
  assert.equal(parseCssColorToHexOrRgb('rgba(236, 228, 212, 0.68)'), 'rgb(236, 228, 212)')
  assert.equal(parseCssColorToHexOrRgb('rgb(26 21 17 / 0.3)'), 'rgb(26, 21, 17)')
  assert.equal(parseCssColorToHexOrRgb('rgb(26 21 17 / 30%)'), 'rgb(26, 21, 17)')
  assert.equal(parseCssColorToHexOrRgb('rgba(26 21 17 / 0.44)'), 'rgb(26, 21, 17)')
  assert.equal(parseCssColorToHexOrRgb('rgb(26 21 17)'), 'rgb(26, 21, 17)')
})

test('three.Color.setStyle parses minified paper and night theme tokens without falling back to white', () => {
  // Paper theme L0 (--tone-l0: rgba(26, 21, 17, 0.30) minified to #1a15114d)
  const paperL0 = new Color().setStyle(parseCssColorToHexOrRgb('#1a15114d'), LinearSRGBColorSpace)
  assert.equal(paperL0.getHexString(LinearSRGBColorSpace), '1a1511')

  // Paper theme L1 (--tone-l1: rgba(26, 21, 17, 0.58) minified to #1a151194)
  const paperL1 = new Color().setStyle(parseCssColorToHexOrRgb('#1a151194'), LinearSRGBColorSpace)
  assert.equal(paperL1.getHexString(LinearSRGBColorSpace), '1a1511')

  // Paper theme edge line (--text-3: rgba(26, 21, 17, 0.44) minified to #1a151170)
  const paperEdge = new Color().setStyle(parseCssColorToHexOrRgb('#1a151170'), LinearSRGBColorSpace)
  assert.equal(paperEdge.getHexString(LinearSRGBColorSpace), '1a1511')

  // Night theme L0 (--tone-l0: rgba(236, 228, 212, 0.38) minified to #ece4d461)
  const nightL0 = new Color().setStyle(parseCssColorToHexOrRgb('#ece4d461'), LinearSRGBColorSpace)
  assert.equal(nightL0.getHexString(LinearSRGBColorSpace), 'ece4d4')

  // CSS Color 4 space syntax
  const spaceColor = new Color().setStyle(parseCssColorToHexOrRgb('rgb(26 21 17 / 0.3)'), LinearSRGBColorSpace)
  assert.equal(spaceColor.getHexString(LinearSRGBColorSpace), '1a1511')
})
