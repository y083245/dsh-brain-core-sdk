import assert from 'node:assert/strict'
import test from 'node:test'
import { computeLayout, type LayoutInput } from '../../web/src/memory/graph/layout.ts'

const input: LayoutInput = {
  seed: 1729,
  layers: Array.from({ length: 64 }, (_, index) => Math.floor(index / 16)),
  edges: Array.from({ length: 48 }, (_, index) => [index, index + 16] as const),
}

test('layout is deterministic for a fixed seed and changes with the seed', () => {
  const first = computeLayout(input)
  assert.deepEqual(computeLayout(input), first)
  assert.notDeepEqual(computeLayout({ ...input, seed: 1730 }), first)
  assert.equal(first.length, input.layers.length * 2)
  assert.ok(first.every(Number.isFinite))
})

test('L3 is closest to the center of a connected evidence graph', () => {
  const positions = computeLayout(input)
  const radii = [0, 0, 0, 0]
  input.layers.forEach((layer, index) => {
    radii[layer]! += Math.hypot(positions[index * 2]!, positions[index * 2 + 1]!)
  })
  assert.ok(radii[3]! < Math.min(radii[0]!, radii[1]!, radii[2]!))
})

test('4000 nodes + 6000 edges completes within 2500ms without NaN and preserves layer rings', () => {
  // Small warmup to eliminate JIT/TypedArray cold-start jitter before timing
  computeLayout(input)

  const layers: number[] = []
  // 20 L3, 180 L2, 800 L1, 3000 L0 = 4000 nodes
  for (let i = 0; i < 20; i++) layers.push(3)
  for (let i = 0; i < 180; i++) layers.push(2)
  for (let i = 0; i < 800; i++) layers.push(1)
  for (let i = 0; i < 3000; i++) layers.push(0)

  const edges: [number, number][] = []
  // 6000 upward evidence edges
  for (let i = 0; i < 4000; i++) {
    const l0 = 1000 + (i % 3000)
    const l1 = 200 + ((i * 7) % 800)
    edges.push([l0, l1])
  }
  for (let i = 0; i < 1600; i++) {
    const l1 = 200 + (i % 800)
    const l2 = 20 + ((i * 5) % 180)
    edges.push([l1, l2])
  }
  for (let i = 0; i < 400; i++) {
    const l2 = 20 + (i % 180)
    const l3 = (i * 3) % 20
    edges.push([l2, l3])
  }

  const start = performance.now()
  const positions = computeLayout({ layers, edges, seed: 42 })
  const elapsedMs = performance.now() - start

  assert.equal(positions.length, 8000)
  assert.ok(positions.every(Number.isFinite), 'all coordinates must be finite')
  assert.ok(elapsedMs <= 2500, `expected <= 2500ms (§11 target), got ${elapsedMs.toFixed(1)}ms`)

  const sums = [0, 0, 0, 0]
  const counts = [0, 0, 0, 0]
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!
    sums[layer]! += Math.hypot(positions[i * 2]!, positions[i * 2 + 1]!)
    counts[layer]! += 1
  }
  const avg = sums.map((sum, layer) => sum / counts[layer]!)
  assert.ok(avg[3]! < avg[2]!, `expected avg L3 (${avg[3]!.toFixed(1)}) < L2 (${avg[2]!.toFixed(1)})`)
  assert.ok(avg[2]! < avg[1]!, `expected avg L2 (${avg[2]!.toFixed(1)}) < L1 (${avg[1]!.toFixed(1)})`)
  assert.ok(avg[1]! < avg[0]!, `expected avg L1 (${avg[1]!.toFixed(1)}) < L0 (${avg[0]!.toFixed(1)})`)
})
