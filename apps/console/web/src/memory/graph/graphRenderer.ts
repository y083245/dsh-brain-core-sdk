import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from 'three'

import type { MemoryRecord } from '../../api/types.ts'
import type { ExternalRenderHook } from '../../ink/engine.ts'
import { REDUCED_FADE_DURATION } from '../../motion/presets.ts'
import { DUR } from '../../motion/tokens.ts'
import {
  edgeKey,
  type ForgetDissolveState,
  type ForgetPreviewState,
} from '../../pages/memory/forgetPreview.ts'
import {
  edgeFragmentShader,
  edgeVertexShader,
  nodeFragmentShader,
  nodeVertexShader,
} from './graphShaders.ts'

const NODE_RADII = [2.5, 4, 6, 11]
const THEMATIC_OPACITY = {
  night: [0.38, 0.68, 1, 1],
  paper: [0.30, 0.58, 1, 1],
}
const PREVIEW_DEPTH_STAGGER_MS = 120
const DISSOLVE_DEPTH_STAGGER_MS = 140

export interface GraphNodeGeometry {
  readonly id: string
  readonly layer: number
  readonly x: number
  readonly y: number
}

export interface GraphGeometry {
  readonly nodes: readonly GraphNodeGeometry[]
  readonly edges: ReadonlyArray<readonly [number, number]>
}

export interface EdgeDisconnectSchedule {
  readonly order: ReadonlyMap<number, number>
  readonly stepMs: number
}

export interface CameraState {
  x: number
  y: number
  zoom: number
}

export interface GraphAppearance {
  readonly records: readonly MemoryRecord[]
  readonly hovered: number | null
  readonly selected: string | undefined
  readonly personId: string
  readonly theme: 'night' | 'paper'
  readonly motion: boolean
  readonly forgetPreview: ForgetPreviewState | null
  readonly forgetDissolve: ForgetDissolveState | null
  readonly edgeDisconnect: EdgeDisconnectSchedule | null
}

export function parseCssColorToHexOrRgb(raw: string): string {
  const color = raw.trim()
  if (color === '') return color

  // Strip alpha from 8-digit (#RRGGBBAA) and 4-digit (#RGBA) hex produced by CSS minifiers.
  if (/^#[0-9a-f]{8}$/i.test(color)) {
    return color.slice(0, 7)
  }
  if (/^#[0-9a-f]{4}$/i.test(color)) {
    return color.slice(0, 4)
  }

  // Legacy comma syntax: rgba(r, g, b, a) / rgb(r, g, b) -> rgb(r, g, b)
  const commaMatch = /^rgba?\(\s*([^,\s)]+)\s*,\s*([^,\s)]+)\s*,\s*([^,\s)]+)(?:\s*,\s*[^)]+)?\s*\)$/i.exec(color)
  if (commaMatch) {
    return `rgb(${commaMatch[1]}, ${commaMatch[2]}, ${commaMatch[3]})`
  }

  // CSS Color 4 space syntax: rgb(r g b / a) / rgba(r g b / a) / rgb(r g b) -> rgb(r, g, b)
  const spaceMatch = /^rgba?\(\s*([^/\s,)]+)\s+([^/\s,)]+)\s+([^/\s,)]+)(?:\s*\/\s*[^)]+)?\s*\)$/i.exec(color)
  if (spaceMatch) {
    return `rgb(${spaceMatch[1]}, ${spaceMatch[2]}, ${spaceMatch[3]})`
  }

  return color
}

function cssColor(style: CSSStyleDeclaration, token: string): Color {
  const normalized = parseCssColorToHexOrRgb(style.getPropertyValue(token))
  return new Color().setStyle(normalized, LinearSRGBColorSpace)
}

export function graphRadius(layer: number, zoom: number): number {
  const radius = NODE_RADII[layer] ?? NODE_RADII[0]!
  return layer === 0 && zoom < 0.6 ? radius * 6 : radius
}

function dynamicAttribute(length: number, instanced = false) {
  const array = new Float32Array(length)
  const attribute = instanced ? new InstancedBufferAttribute(array, 1) : new BufferAttribute(array, 1)
  attribute.setUsage(DynamicDrawUsage)
  return { array, attribute }
}

export function createGraphRenderer(gl: WebGL2RenderingContext, graph: GraphGeometry) {
  const renderer = new WebGLRenderer({ canvas: gl.canvas as HTMLCanvasElement, context: gl, antialias: true })
  const scene = new Scene()
  const camera = new OrthographicCamera()
  camera.position.z = 2
  renderer.autoClear = false

  const nodeShape = new PlaneGeometry(2, 2)
  const nodeLayer = new InstancedBufferAttribute(Float32Array.from(graph.nodes.map(({ layer }) => layer)), 1)
  const nodeOpacity = dynamicAttribute(graph.nodes.length, true)
  const nodeSelection = dynamicAttribute(graph.nodes.length, true)
  const nodeScale = dynamicAttribute(graph.nodes.length, true)
  const nodeWarn = dynamicAttribute(graph.nodes.length, true)
  nodeShape.setAttribute('aLayer', nodeLayer)
  nodeShape.setAttribute('aOpacity', nodeOpacity.attribute)
  nodeShape.setAttribute('aSelected', nodeSelection.attribute)
  nodeShape.setAttribute('aScale', nodeScale.attribute)
  nodeShape.setAttribute('aWarn', nodeWarn.attribute)
  const nodeMaterial = new ShaderMaterial({
    vertexShader: nodeVertexShader,
    fragmentShader: nodeFragmentShader,
    uniforms: {
      uTone: { value: [new Color(), new Color(), new Color(), new Color()] },
      uSeal: { value: new Color() },
      uWarn: { value: new Color() },
      uTime: { value: 0 },
      uZoom: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
  })
  const nodes = new InstancedMesh(nodeShape, nodeMaterial, graph.nodes.length)
  nodes.frustumCulled = false
  nodes.renderOrder = 2
  const matrix = new Matrix4()
  graph.nodes.forEach(({ x, y }, index) => {
    matrix.makeTranslation(x, y, 0)
    nodes.setMatrixAt(index, matrix)
  })
  scene.add(nodes)

  const edgeShape = new BufferGeometry()
  const edgePositions = new Float32Array(graph.edges.length * 18)
  const edgeU = new Float32Array(graph.edges.length * 6)
  const edgeOpacity = dynamicAttribute(edgeU.length)
  const edgeSpeed = dynamicAttribute(edgeU.length)
  const edgeReverse = dynamicAttribute(edgeU.length)
  const adjacent = Array.from({ length: graph.nodes.length }, () => new Set<number>())
  graph.edges.forEach(([from, to], index) => {
    const a = graph.nodes[from]!
    const b = graph.nodes[to]!
    adjacent[from]!.add(to)
    adjacent[to]!.add(from)
    const distance = Math.max(0.0001, Math.hypot(b.x - a.x, b.y - a.y))
    const x = (-0.55 * (b.y - a.y)) / distance
    const y = (0.55 * (b.x - a.x)) / distance
    edgePositions.set([
      a.x + x, a.y + y, 0, a.x - x, a.y - y, 0, b.x - x, b.y - y, 0,
      a.x + x, a.y + y, 0, b.x - x, b.y - y, 0, b.x + x, b.y + y, 0,
    ], index * 18)
    edgeU.set([0, 0, 1, 0, 1, 1], index * 6)
  })
  edgeShape.setAttribute('position', new BufferAttribute(edgePositions, 3))
  edgeShape.setAttribute('aU', new BufferAttribute(edgeU, 1))
  edgeShape.setAttribute('aOpacity', edgeOpacity.attribute)
  edgeShape.setAttribute('aSpeed', edgeSpeed.attribute)
  edgeShape.setAttribute('aReverse', edgeReverse.attribute)
  const edgeMaterial = new ShaderMaterial({
    vertexShader: edgeVertexShader,
    fragmentShader: edgeFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uLine: { value: new Color() },
      uFlow: { value: new Color() },
      uWarn: { value: new Color() },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
  })
  const edges = new Mesh(edgeShape, edgeMaterial)
  edges.frustumCulled = false
  edges.renderOrder = 1
  scene.add(edges)

  let previousTheme: GraphAppearance['theme'] | undefined
  let ready = false
  let previousHovered: number | null = null
  let hoveredAge = 0
  let previousScale = 1
  let oldHoverScale = 1

  return {
    draw(rect: DOMRect, view: CameraState, appearance: GraphAppearance, info: Parameters<ExternalRenderHook>[1]) {
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top * info.dpr >= info.height) return
      renderer.resetState()
      renderer.setViewport(
        Math.round(rect.left * info.dpr),
        Math.round(info.height - rect.bottom * info.dpr),
        Math.round(rect.width * info.dpr),
        Math.round(rect.height * info.dpr),
      )
      renderer.setScissor(
        Math.round(rect.left * info.dpr),
        Math.round(info.height - rect.bottom * info.dpr),
        Math.round(rect.width * info.dpr),
        Math.round(rect.height * info.dpr),
      )
      renderer.setScissorTest(true)
      camera.left = -rect.width / (2 * view.zoom)
      camera.right = -camera.left
      camera.top = rect.height / (2 * view.zoom)
      camera.bottom = -camera.top
      camera.position.set(view.x, view.y, 2)
      camera.updateProjectionMatrix()

      if (previousTheme !== appearance.theme) {
        const style = getComputedStyle(document.documentElement)
        const warnColor = cssColor(style, '--tenghuang')
        nodeMaterial.uniforms.uTone!.value = [0, 1, 2, 3].map((layer) => cssColor(style, `--tone-l${layer}`))
        nodeMaterial.uniforms.uSeal!.value = cssColor(style, '--zhusha')
        nodeMaterial.uniforms.uWarn!.value = warnColor
        edgeMaterial.uniforms.uLine!.value = cssColor(style, '--text-3')
        edgeMaterial.uniforms.uFlow!.value = cssColor(style, '--text-1')
        edgeMaterial.uniforms.uWarn!.value = warnColor
        previousTheme = appearance.theme
      }
      nodeMaterial.uniforms.uTime!.value = appearance.motion ? info.timeSec : 0
      nodeMaterial.uniforms.uZoom!.value = view.zoom
      edgeMaterial.uniforms.uTime!.value = appearance.motion ? info.timeSec : 0

      const { records, hovered, forgetPreview, forgetDissolve, edgeDisconnect } = appearance
      if (hovered !== previousHovered) {
        oldHoverScale = previousScale
        hoveredAge = 0
        previousHovered = hovered
      }
      hoveredAge += info.dtSec
      const normalized = hoveredAge / DUR.base
      const scale = hovered === null ? 1 : 1.6
      previousScale = appearance.motion && normalized < 1
        ? scale + (oldHoverScale - scale) * Math.exp(-7 * normalized) * Math.cos(8 * normalized)
        : scale
      const hot = hovered === null ? undefined : adjacent[hovered]
      const blend = appearance.motion && ready ? Math.min(1, info.dtSec / (DUR.base * 0.4)) : 1
      const nowMs = performance.now()
      const dissolveDurMs = (appearance.motion ? DUR.dissolve : REDUCED_FADE_DURATION) * 1000
      const cutDurMs = (appearance.motion ? DUR.quick : REDUCED_FADE_DURATION) * 1000

      graph.nodes.forEach(({ id, layer }, index) => {
        const record = records[index]
        const personOpacity = !appearance.personId || (record !== undefined && record.subjects.includes(appearance.personId)) ? 1 : 0.1
        const focusOpacity = hovered === null || hovered === index || hot?.has(index) ? 1 : 0.25

        const previewDepth = forgetPreview?.depthById.get(id)
        const previewLit =
          previewDepth !== undefined &&
          (!appearance.motion || nowMs - forgetPreview!.startedAtMs >= previewDepth * PREVIEW_DEPTH_STAGGER_MS)
        const targetWarn = previewLit ? 1 : 0
        nodeWarn.array[index]! += (targetWarn - nodeWarn.array[index]!) * blend

        const baseOpacity = previewLit
          ? 1
          : Math.min(personOpacity, focusOpacity) * THEMATIC_OPACITY[appearance.theme][layer]!

        const eraseDepth = forgetDissolve?.erasedDepthById.get(id)
        if (eraseDepth !== undefined && forgetDissolve) {
          const delayMs = appearance.motion ? eraseDepth * DISSOLVE_DEPTH_STAGGER_MS : 0
          const elapsed = Math.max(0, nowMs - forgetDissolve.startedAtMs - delayMs)
          const progress = Math.min(1, elapsed / dissolveDurMs)
          const remaining = 1 - progress
          nodeOpacity.array[index] = baseOpacity * remaining
          nodeScale.array[index] = graphRadius(layer, view.zoom) * remaining
          nodeSelection.array[index] = 0
        } else {
          nodeOpacity.array[index]! += (baseOpacity - nodeOpacity.array[index]!) * blend
          nodeSelection.array[index] = appearance.selected === id ? 1 : 0
          const previewBoost = previewLit ? 1.25 : 1
          nodeScale.array[index] = graphRadius(layer, view.zoom) * (hovered === index ? previousScale : previewBoost)
        }
      })

      graph.edges.forEach(([from, to], index) => {
        const fromNode = graph.nodes[from]!
        const toNode = graph.nodes[to]!
        const fromRecord = records[from]
        const toRecord = records[to]
        const focused = hovered === null || hovered === from || hovered === to
        const personDim = !appearance.personId ||
          (fromRecord !== undefined && fromRecord.subjects.includes(appearance.personId)) ||
          (toRecord !== undefined && toRecord.subjects.includes(appearance.personId)) ? 1 : 0.1

        const edgePreviewDepth = forgetPreview?.edgeDepthByKey.get(edgeKey(fromNode.id, toNode.id))
        const reverseLit =
          edgePreviewDepth !== undefined &&
          (!appearance.motion || nowMs - forgetPreview!.startedAtMs >= edgePreviewDepth * PREVIEW_DEPTH_STAGGER_MS)

        const targetOpacity = reverseLit ? 1 : (focused ? personDim : Math.min(0.25, personDim))
        const targetSpeed = reverseLit ? 2.5 : (focused && hovered !== null ? 3 : 1)
        const targetReverse = reverseLit ? 1 : 0

        const disconnectOrder = forgetDissolve ? edgeDisconnect?.order.get(index) : undefined
        let disconnectFactor = 1
        if (forgetDissolve && edgeDisconnect && disconnectOrder !== undefined) {
          const delayMs = appearance.motion ? disconnectOrder * edgeDisconnect.stepMs : 0
          const elapsed = nowMs - forgetDissolve.startedAtMs - delayMs
          if (elapsed >= 0) {
            disconnectFactor = Math.max(0, 1 - elapsed / cutDurMs)
          }
        }

        const start = index * 6
        for (let offset = start; offset < start + 6; offset++) {
          if (disconnectFactor < 1) {
            edgeOpacity.array[offset] = targetOpacity * disconnectFactor
          } else {
            edgeOpacity.array[offset]! += (targetOpacity - edgeOpacity.array[offset]!) * blend
          }
          edgeSpeed.array[offset] = targetSpeed
          edgeReverse.array[offset] = targetReverse
        }
      })

      ready = true
      nodeOpacity.attribute.needsUpdate = true
      nodeSelection.attribute.needsUpdate = true
      nodeScale.attribute.needsUpdate = true
      nodeWarn.attribute.needsUpdate = true
      edgeOpacity.attribute.needsUpdate = true
      edgeSpeed.attribute.needsUpdate = true
      edgeReverse.attribute.needsUpdate = true
      renderer.render(scene, camera)
      renderer.resetState()
    },
    dispose() {
      nodeShape.dispose()
      nodeMaterial.dispose()
      nodes.dispose()
      edgeShape.dispose()
      edgeMaterial.dispose()
      renderer.dispose()
    },
  }
}
