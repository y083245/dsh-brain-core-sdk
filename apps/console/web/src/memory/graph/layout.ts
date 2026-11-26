export interface LayoutInput {
  readonly layers: readonly number[]
  readonly edges: ReadonlyArray<readonly [number, number]>
  readonly seed: number
}

const LAYER_PULL = [0.008, 0.025, 0.075, 0.24]
const LAYER_SPREAD = [380, 240, 140, 45]
const LAYER_RADII = [2.5, 4, 6, 11]
const ITERATIONS = 300
const THETA = 0.85
const INV_THETA_SQ = 1 / (THETA * THETA)
const MIN_CELL_SIZE = 0.2

function randomSource(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let next = Math.imul(state ^ (state >>> 15), 1 | state)
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Reusable flat TypedArray pool for building and linearizing the Barnes-Hut quadtree
 * into a cache-friendly pre-order traversal array with zero per-iteration allocations.
 */
interface QuadPool {
  capacity: number
  count: number
  // Build tree arrays
  x: Float64Array
  y: Float64Array
  size: Float64Array
  mass: Int32Array
  sumX: Float64Array
  sumY: Float64Array
  child: Int32Array
  bodyHead: Int32Array
  bodyNext: Int32Array
  // Linearized pre-order DFS traversal arrays (only non-empty nodes)
  flatX: Float64Array
  flatY: Float64Array
  flatThresh: Float64Array
  flatWeight: Float64Array
  flatBody: Int32Array
  flatNext: Int32Array
  // Scratch stack for iterative linearization
  dfsNode: Int32Array
  // Bodies in spatial (quadtree) order for branch-prediction & L1 cache locality
  bodyOrder: Int32Array
}

function createQuadPool(bodyCount: number): QuadPool {
  const capacity = Math.max(64, bodyCount * 4)
  return {
    capacity,
    count: 0,
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    size: new Float64Array(capacity),
    mass: new Int32Array(capacity),
    sumX: new Float64Array(capacity),
    sumY: new Float64Array(capacity),
    child: new Int32Array(capacity),
    bodyHead: new Int32Array(capacity),
    bodyNext: new Int32Array(bodyCount),
    flatX: new Float64Array(capacity),
    flatY: new Float64Array(capacity),
    flatThresh: new Float64Array(capacity),
    flatWeight: new Float64Array(capacity),
    flatBody: new Int32Array(capacity),
    flatNext: new Int32Array(capacity),
    dfsNode: new Int32Array(capacity * 2),
    bodyOrder: new Int32Array(bodyCount),
  }
}

function growQuadPool(pool: QuadPool, minCapacity: number): void {
  let nextCap = pool.capacity * 2
  while (nextCap < minCapacity) nextCap *= 2

  const growF64 = (src: Float64Array): Float64Array => {
    const dst = new Float64Array(nextCap)
    dst.set(src)
    return dst
  }
  const growI32 = (src: Int32Array): Int32Array => {
    const dst = new Int32Array(nextCap)
    dst.set(src)
    return dst
  }

  pool.capacity = nextCap
  pool.x = growF64(pool.x)
  pool.y = growF64(pool.y)
  pool.size = growF64(pool.size)
  pool.mass = growI32(pool.mass)
  pool.sumX = growF64(pool.sumX)
  pool.sumY = growF64(pool.sumY)
  pool.child = growI32(pool.child)
  pool.bodyHead = growI32(pool.bodyHead)
  pool.flatX = new Float64Array(nextCap)
  pool.flatY = new Float64Array(nextCap)
  pool.flatThresh = new Float64Array(nextCap)
  pool.flatWeight = new Float64Array(nextCap)
  pool.flatBody = new Int32Array(nextCap)
  pool.flatNext = new Int32Array(nextCap)
  pool.dfsNode = new Int32Array(nextCap * 2)
}

function initQuadNode(pool: QuadPool, idx: number, x: number, y: number, size: number): void {
  pool.x[idx] = x
  pool.y[idx] = y
  pool.size[idx] = size
  pool.mass[idx] = 0
  pool.sumX[idx] = 0
  pool.sumY[idx] = 0
  pool.child[idx] = -1
  pool.bodyHead[idx] = -1
}

function insertBody(pool: QuadPool, root: number, bodyIndex: number, positions: Float64Array): void {
  const bx = positions[bodyIndex * 2]!
  const by = positions[bodyIndex * 2 + 1]!
  let node = root

  for (;;) {
    pool.mass[node] = pool.mass[node]! + 1
    pool.sumX[node] = pool.sumX[node]! + bx
    pool.sumY[node] = pool.sumY[node]! + by

    let childBase = pool.child[node]!
    if (childBase === -1) {
      const existing = pool.bodyHead[node]!
      const cellSize = pool.size[node]!
      if (existing === -1 || cellSize < MIN_CELL_SIZE) {
        pool.bodyNext[bodyIndex] = existing
        pool.bodyHead[node] = bodyIndex
        return
      }

      if (pool.count + 4 > pool.capacity) {
        growQuadPool(pool, pool.count + 4)
      }
      childBase = pool.count
      pool.count += 4
      pool.child[node] = childBase
      pool.bodyHead[node] = -1

      const cx = pool.x[node]!
      const cy = pool.y[node]!
      const half = cellSize * 0.5
      initQuadNode(pool, childBase, cx, cy, half)
      initQuadNode(pool, childBase + 1, cx + half, cy, half)
      initQuadNode(pool, childBase + 2, cx, cy + half, half)
      initQuadNode(pool, childBase + 3, cx + half, cy + half, half)

      const ex = positions[existing * 2]!
      const ey = positions[existing * 2 + 1]!
      const eq = (ex >= cx + half ? 1 : 0) + (ey >= cy + half ? 2 : 0)
      const eChild = childBase + eq
      pool.mass[eChild] = 1
      pool.sumX[eChild] = ex
      pool.sumY[eChild] = ey
      pool.bodyNext[existing] = -1
      pool.bodyHead[eChild] = existing

      const bq = (bx >= cx + half ? 1 : 0) + (by >= cy + half ? 2 : 0)
      node = childBase + bq
      continue
    }

    const half = pool.size[node]! * 0.5
    const q = (bx >= pool.x[node]! + half ? 1 : 0) + (by >= pool.y[node]! + half ? 2 : 0)
    node = childBase + q
  }
}

/**
 * Compacts the non-empty quadtree nodes into a pre-order DFS flat array where:
 * - Opening an internal node is simply `k + 1`.
 * - Skipping a subtree (far enough or leaf) is simply `flatNext[k]`.
 * Also fills `pool.bodyOrder` with bodies in spatial order for cache locality.
 */
function linearizeTree(pool: QuadPool): number {
  const qSize = pool.size
  const qMass = pool.mass
  const qSumX = pool.sumX
  const qSumY = pool.sumY
  const qChild = pool.child
  const qBodyHead = pool.bodyHead
  const qBodyNext = pool.bodyNext

  const flatX = pool.flatX
  const flatY = pool.flatY
  const flatThresh = pool.flatThresh
  const flatWeight = pool.flatWeight
  const flatBody = pool.flatBody
  const flatNext = pool.flatNext
  const bodyOrder = pool.bodyOrder

  const dfsNode = pool.dfsNode

  let flatCount = 0
  let orderCount = 0
  let sp = 1
  // Positive entry: visit quadtree node; negative entry: -(flatIdx + 1) marks subtree end
  dfsNode[0] = 0

  while (sp > 0) {
    const token = dfsNode[--sp]!
    if (token < 0) {
      flatNext[-(token + 1)] = flatCount
      continue
    }

    const node = token
    const m = qMass[node]!
    if (m === 0) continue

    const childBase = qChild[node]!
    // Path compression: skip single-child internal chains with identical mass
    if (childBase !== -1) {
      let onlyChild = -1
      let nonEmpty = 0
      if (qMass[childBase]! > 0) { onlyChild = childBase; nonEmpty++ }
      if (qMass[childBase + 1]! > 0) { onlyChild = childBase + 1; nonEmpty++ }
      if (qMass[childBase + 2]! > 0) { onlyChild = childBase + 2; nonEmpty++ }
      if (qMass[childBase + 3]! > 0) { onlyChild = childBase + 3; nonEmpty++ }
      if (nonEmpty === 1) {
        dfsNode[sp++] = onlyChild
        continue
      }
    }

    const flatIdx = flatCount++
    const invM = 1 / m
    flatX[flatIdx] = qSumX[node]! * invM
    flatY[flatIdx] = qSumY[node]! * invM
    const sz = qSize[node]!
    flatThresh[flatIdx] = sz * sz * INV_THETA_SQ
    flatWeight[flatIdx] = 520 * m

    if (childBase === -1) {
      const head = qBodyHead[node]!
      if (m === 1) {
        flatBody[flatIdx] = head
        bodyOrder[orderCount++] = head
      } else {
        flatBody[flatIdx] = -(head + 2)
        let b = head
        while (b !== -1) {
          bodyOrder[orderCount++] = b
          b = qBodyNext[b]!
        }
      }
      flatNext[flatIdx] = flatCount
    } else {
      flatBody[flatIdx] = -1
      // Push sentinel to record subtree exit index once all children finish
      dfsNode[sp++] = -(flatIdx + 1)
      if (qMass[childBase + 3]! > 0) dfsNode[sp++] = childBase + 3
      if (qMass[childBase + 2]! > 0) dfsNode[sp++] = childBase + 2
      if (qMass[childBase + 1]! > 0) dfsNode[sp++] = childBase + 1
      if (qMass[childBase]! > 0) dfsNode[sp++] = childBase
    }
  }

  return flatCount
}

/** Runs a fixed 300-step Barnes–Hut simulation in the worker. */
export function computeLayout({ layers, edges, seed }: LayoutInput): Float32Array {
  const count = layers.length
  if (count === 0) return new Float32Array(0)

  const positions = new Float64Array(count * 2)
  const velocities = new Float64Array(count * 2)
  const forces = new Float64Array(count * 2)
  const pulls = new Float64Array(count)
  const radii = new Float64Array(count)

  const random = randomSource(seed)
  for (let i = 0; i < count; i++) {
    const layer = layers[i]!
    pulls[i] = LAYER_PULL[layer] ?? LAYER_PULL[0]!
    radii[i] = LAYER_RADII[layer] ?? 0
    const angle = random() * 2 * Math.PI
    const radius = Math.sqrt(random()) * (LAYER_SPREAD[layer] ?? LAYER_SPREAD[0]!)
    positions[i * 2] = Math.cos(angle) * radius
    positions[i * 2 + 1] = Math.sin(angle) * radius
  }

  let validEdgeCount = 0
  for (let e = 0; e < edges.length; e++) {
    const pair = edges[e]!
    const from = pair[0]
    const to = pair[1]
    if (from >= 0 && from < count && to >= 0 && to < count && from !== to) {
      validEdgeCount++
    }
  }
  const edgeFrom = new Int32Array(validEdgeCount)
  const edgeTo = new Int32Array(validEdgeCount)
  let edgeWrite = 0
  for (let e = 0; e < edges.length; e++) {
    const pair = edges[e]!
    const from = pair[0]
    const to = pair[1]
    if (from >= 0 && from < count && to >= 0 && to < count && from !== to) {
      edgeFrom[edgeWrite] = from * 2
      edgeTo[edgeWrite] = to * 2
      edgeWrite++
    }
  }

  const pool = createQuadPool(count)
  const posLen = count * 2

  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    let bound = 1
    for (let i = 0; i < posLen; i++) {
      const absVal = Math.abs(positions[i]!) + 1
      if (absVal > bound) bound = absVal
    }

    pool.count = 1
    initQuadNode(pool, 0, -bound, -bound, bound * 2)
    for (let i = 0; i < count; i++) {
      insertBody(pool, 0, i, positions)
    }

    const flatCount = linearizeTree(pool)
    const flatX = pool.flatX
    const flatY = pool.flatY
    const flatThresh = pool.flatThresh
    const flatWeight = pool.flatWeight
    const flatBody = pool.flatBody
    const flatNext = pool.flatNext
    const qBodyNext = pool.bodyNext
    const bodyOrder = pool.bodyOrder

    // Radial pull + Barnes-Hut repulsion (traverse bodies in spatial order)
    for (let ord = 0; ord < count; ord++) {
      const i = bodyOrder[ord]!
      const offset = i * 2
      const px = positions[offset]!
      const py = positions[offset + 1]!
      const kPull = pulls[i]!
      let fx = -px * kPull
      let fy = -py * kPull
      const ri = radii[i]!

      let k = 0
      while (k < flatCount) {
        const dx = px - flatX[k]!
        const dy = py - flatY[k]!
        const distSq = dx * dx + dy * dy
        const body = flatBody[k]!

        if (body === -1) {
          if (distSq > flatThresh[k]!) {
            const softened = distSq + 110
            const scale = flatWeight[k]! / (softened * Math.sqrt(softened))
            fx += dx * scale
            fy += dy * scale
            k = flatNext[k]!
          } else {
            k++
          }
        } else if (body >= 0) {
          if (body !== i) {
            const softened = distSq + 110
            let scale = 520 / (softened * Math.sqrt(softened))
            const spacing = ri + radii[body]! + 3
            if (distSq > 0 && distSq < spacing * spacing) {
              const dist = Math.sqrt(distSq)
              scale += (0.4 * (spacing - dist)) / dist
            }
            fx += dx * scale
            fy += dy * scale
          }
          k = flatNext[k]!
        } else {
          let b = -(body + 2)
          while (b !== -1) {
            if (b !== i) {
              const bdx = px - positions[b * 2]!
              const bdy = py - positions[b * 2 + 1]!
              const bDistSq = bdx * bdx + bdy * bdy
              const softened = bDistSq + 110
              let scale = 520 / (softened * Math.sqrt(softened))
              const spacing = ri + radii[b]! + 3
              if (bDistSq > 0 && bDistSq < spacing * spacing) {
                const dist = Math.sqrt(bDistSq)
                scale += (0.4 * (spacing - dist)) / dist
              }
              fx += bdx * scale
              fy += bdy * scale
            }
            b = qBodyNext[b]!
          }
          k = flatNext[k]!
        }
      }

      forces[offset] = fx
      forces[offset + 1] = fy
    }

    // Spring edges
    for (let e = 0; e < validEdgeCount; e++) {
      const a = edgeFrom[e]!
      const b = edgeTo[e]!
      const dx = positions[b]! - positions[a]!
      const dy = positions[b + 1]! - positions[a + 1]!
      const distSq = dx * dx + dy * dy
      if (distSq < 1e-12) continue
      const distance = Math.sqrt(distSq)
      const spring = (0.019 * (distance - 48)) / distance
      const sdx = dx * spring
      const sdy = dy * spring
      forces[a] = forces[a]! + sdx
      forces[a + 1] = forces[a + 1]! + sdy
      forces[b] = forces[b]! - sdx
      forces[b + 1] = forces[b + 1]! - sdy
    }

    const maxStep = 2 + 12 * (1 - iteration / ITERATIONS)
    const negMaxStep = -maxStep
    for (let i = 0; i < posLen; i++) {
      let velocity = velocities[i]! * 0.78 + forces[i]! * 0.28
      if (velocity > maxStep) velocity = maxStep
      else if (velocity < negMaxStep) velocity = negMaxStep
      velocities[i] = velocity
      positions[i] = positions[i]! + velocity
    }
  }

  return new Float32Array(positions)
}
