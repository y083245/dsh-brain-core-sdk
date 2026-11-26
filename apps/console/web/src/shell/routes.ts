import { createElement, type CSSProperties, type ReactElement } from 'react'
import { motion } from 'motion/react'
import { normalizeRoute } from '../data/store.ts'
import { getPreset } from '../motion/presets.ts'
import { STAGGER } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export type StationId =
  | 'court'
  | 'voice'
  | 'memory'
  | 'heart'
  | 'seals'
  | 'pulse'
  | 'ledger'
  | 'settings'

export interface StationDef {
  readonly id: StationId
  readonly glyph: string
  readonly title: string
  readonly label: string
  readonly description: string
  readonly strokes: readonly string[]
}

export const STATIONS: readonly StationDef[] = [
  {
    id: 'court',
    glyph: '庭',
    title: '总览',
    label: 'COURT · OVERVIEW',
    description: '总览与状态',
    // 一横一竖的「亭」字头简笔
    strokes: [
      'M 4 8.5 Q 12 6.8 20 8.5',
      'M 12 4.5 Q 11.7 12.5 12 20',
    ],
  },
  {
    id: 'voice',
    glyph: '语',
    title: '对话',
    label: 'VOICE · CHAT',
    description: '与她对话',
    // 一道起伏的波线
    strokes: [
      'M 3 13 C 6.2 7, 8.8 18.5, 12 12 C 15.2 5.5, 17.8 17, 21 11',
    ],
  },
  {
    id: 'memory',
    glyph: '忆',
    title: '记忆',
    label: 'MEMORY · STRATA',
    description: '墨阶记忆与证据链',
    // 三道由短到长的横笔（墨阶）
    strokes: [
      'M 8.5 6.5 Q 12 6 15.5 6.5',
      'M 6 12 Q 12 11.4 18 12',
      'M 3.5 17.5 Q 12 16.9 20.5 17.5',
    ],
  },
  {
    id: 'heart',
    glyph: '心',
    title: '心潮',
    label: 'HEART · L3 & TIDE',
    description: 'L3 身份卷与夜间巩固',
    // 一个点 + 一道弧
    strokes: [
      'M 11.4 6.6 Q 12.1 5.7 12.8 6.8',
      'M 5 12.5 C 7.2 18.5, 16.8 18.5, 19 11.5',
    ],
  },
  {
    id: 'seals',
    glyph: '印',
    title: '印谱',
    label: 'SEALS · PLUGINS',
    description: '插件印谱与契约',
    // 一个方框，右下角缺一笔
    strokes: [
      'M 19 14.5 L 19 5.5 L 5 5.5 L 5 18.5 L 14.5 18.5',
    ],
  },
  {
    id: 'pulse',
    glyph: '脉',
    title: '脉动',
    label: 'PULSE · RUNTIME',
    description: '附属运行时脉动',
    // 一道心跳折线
    strokes: [
      'M 2.5 13 L 7 13 L 9.5 6.5 L 13 18 L 15.8 10.5 L 18 13 L 21.5 13',
    ],
  },
  {
    id: 'ledger',
    glyph: '账',
    title: '账通',
    label: 'LEDGER · COST & INTEROP',
    description: '花费统计与互联',
    // 两道竖笔 + 一横
    strokes: [
      'M 8 5 Q 7.6 12 8 19',
      'M 16 5 Q 15.6 12 16 19',
      'M 4.5 12.2 Q 12 11.6 19.5 12.2',
    ],
  },
  {
    id: 'settings',
    glyph: '设',
    title: '设置',
    label: 'SETTINGS',
    description: '模型、密钥、角色卡与界面',
    // 一个小圆 + 一短横
    strokes: [
      'M 12 5.5 A 4.5 4.5 0 1 0 12 14.5 A 4.5 4.5 0 1 0 12 5.5',
      'M 7 18.5 Q 12 18 17 18.5',
    ],
  },
] as const

const STATION_BY_ID: ReadonlyMap<string, StationDef> = new Map(
  STATIONS.map((station) => [station.id, station]),
)

export interface PluginPageRouteMatch {
  readonly pluginId: string
  readonly pageId: string
}

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function parsePluginPageRoute(route: string): PluginPageRouteMatch | null {
  const cleaned = route.replace(/^#/, '').trim()
  const withoutQuery = cleaned.split('?')[0] ?? ''
  const parts = withoutQuery.split('/')
  if (parts.length !== 3 || parts[0] !== 'page') {
    return null
  }
  const rawPluginId = parts[1]?.trim() ?? ''
  const rawPageId = parts[2]?.trim() ?? ''
  if (rawPluginId === '' || rawPageId === '') {
    return null
  }
  return {
    pluginId: safeDecodeSegment(rawPluginId),
    pageId: safeDecodeSegment(rawPageId),
  }
}

export function isPluginPageRoute(route: string): boolean {
  return parsePluginPageRoute(route) !== null
}

export function resolveStationDef(route: string): StationDef | undefined {
  const normalized = normalizeRoute(route)
  const base = normalized.split(/[/?]/)[0] ?? ''
  return STATION_BY_ID.get(base)
}

export interface StationBrushIconProps {
  readonly stationId: StationId
  readonly size?: number
  readonly drawKey?: number
  readonly strokeWidth?: number
  readonly className?: string
  readonly style?: CSSProperties
}

export function StationBrushIcon({
  stationId,
  size = 24,
  drawKey = 0,
  strokeWidth = 1.75,
  className,
  style,
}: StationBrushIconProps): ReactElement {
  const motionLevel = useMotionLevel()
  const station = STATION_BY_ID.get(stationId)
  const strokes = station?.strokes ?? []
  const shouldAnimate = drawKey > 0 && motionLevel === 'full'
  const brushVariants = getPreset('brushIn', motionLevel)

  const pathNodes = strokes.map((d, index) => {
    if (shouldAnimate) {
      return createElement(motion.path, {
        key: `${stationId}-${String(drawKey)}-${String(index)}`,
        d,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        variants: brushVariants,
        initial: 'initial',
        animate: 'animate',
        custom: index * STAGGER.listStep * 2,
      })
    }
    return createElement('path', {
      key: `${stationId}-static-${String(index)}`,
      d,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    })
  })

  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      className,
      style: {
        display: 'block',
        flexShrink: 0,
        overflow: 'visible',
        ...style,
      },
    },
    ...pathNodes,
  )
}
