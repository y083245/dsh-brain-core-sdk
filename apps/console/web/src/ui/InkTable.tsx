import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { motion } from 'motion/react'
import { getPreset, listStaggerDelay } from '../motion/presets.ts'
import { DUR, SPRING, STAGGER } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export type InkTableRowTone = 'default' | 'warn' | 'danger'

export interface InkTableColumn<T> {
  readonly key: string
  readonly header: ReactNode
  readonly width?: string | number
  readonly align?: 'left' | 'center' | 'right'
  readonly numeric?: boolean
  readonly render: (row: T, index: number) => ReactNode
  readonly headerClassName?: string
  readonly cellClassName?: string
}

export interface InkTableProps<T> {
  readonly columns: readonly InkTableColumn<T>[]
  readonly rows: readonly T[]
  readonly getRowKey: (row: T, index: number) => string | number
  readonly onRowClick?: (row: T, index: number) => void
  readonly selectedKey?: string | number | null
  readonly rowTone?: (row: T, index: number) => InkTableRowTone | undefined
  readonly emptyState?: ReactNode
  readonly rowHeight?: number
  readonly virtualThreshold?: number
  readonly virtualMaxHeight?: number | string
  readonly overscan?: number
  readonly caption?: string
  readonly ariaLabel?: string
  readonly className?: string
  readonly style?: CSSProperties
}

const DEFAULT_ROW_HEIGHT = 44
const DEFAULT_VIRTUAL_THRESHOLD = 200
const DEFAULT_VIRTUAL_MAX_HEIGHT = 480
const DEFAULT_OVERSCAN = 6

const TONE_INDICATOR_COLOR: Readonly<Record<InkTableRowTone, string>> = {
  default: 'var(--zhusha)',
  warn: 'var(--tenghuang)',
  danger: 'var(--yanzhi)',
}

const HEADER_CELL_BASE_STYLE: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-label)',
  lineHeight: 'var(--lh-label)',
  fontWeight: 600,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--text-2)',
  padding: '0 var(--sp-4)',
  height: '36px',
  borderBottom: '1px solid var(--hair-strong)',
  whiteSpace: 'nowrap',
  userSelect: 'none',
  background: 'var(--plate)',
}

function resolveAlignment<T>(col: InkTableColumn<T>): 'left' | 'center' | 'right' {
  if (col.align !== undefined) return col.align
  return col.numeric === true ? 'right' : 'left'
}

export function InkTable<T>({
  columns,
  rows,
  getRowKey,
  onRowClick,
  selectedKey = null,
  rowTone,
  emptyState,
  rowHeight = DEFAULT_ROW_HEIGHT,
  virtualThreshold = DEFAULT_VIRTUAL_THRESHOLD,
  virtualMaxHeight = DEFAULT_VIRTUAL_MAX_HEIGHT,
  overscan = DEFAULT_OVERSCAN,
  caption,
  ariaLabel,
  className,
  style,
}: InkTableProps<T>) {
  const motionLevel = useMotionLevel()
  const tableId = useId()
  const indicatorLayoutId = `ink-table-bar-${tableId}`

  const isVirtualized = rows.length > virtualThreshold
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState<number>(
    typeof virtualMaxHeight === 'number' ? virtualMaxHeight : DEFAULT_VIRTUAL_MAX_HEIGHT,
  )
  const [hoveredKey, setHoveredKey] = useState<string | number | null>(null)
  const [hasScrolled, setHasScrolled] = useState(false)

  useEffect(() => {
    if (!isVirtualized) return
    const container = scrollContainerRef.current
    if (!container) return

    const updateHeight = (): void => {
      if (container.clientHeight > 0) {
        setViewportHeight(container.clientHeight)
      }
    }
    updateHeight()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateHeight)
    observer.observe(container)
    return () => {
      observer.disconnect()
    }
  }, [isVirtualized])

  useEffect(() => {
    if (!isVirtualized) {
      setScrollTop(0)
      setHasScrolled(false)
    }
  }, [isVirtualized])

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    setScrollTop(container.scrollTop)
    if (!hasScrolled && container.scrollTop > 0) {
      setHasScrolled(true)
    }
  }, [hasScrolled])

  const { startIndex, endIndex, topSpacerHeight, bottomSpacerHeight } = useMemo(() => {
    if (!isVirtualized) {
      return {
        startIndex: 0,
        endIndex: rows.length,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0,
      }
    }
    const safeRowHeight = Math.max(1, rowHeight)
    const visibleStart = Math.floor(scrollTop / safeRowHeight)
    const visibleEnd = Math.ceil((scrollTop + viewportHeight) / safeRowHeight)
    const start = Math.max(0, visibleStart - overscan)
    const end = Math.min(rows.length, visibleEnd + overscan)
    return {
      startIndex: start,
      endIndex: end,
      topSpacerHeight: start * safeRowHeight,
      bottomSpacerHeight: Math.max(0, (rows.length - end) * safeRowHeight),
    }
  }, [isVirtualized, overscan, rowHeight, rows.length, scrollTop, viewportHeight])

  const bloomVariants = useMemo(() => getPreset('bloom', motionLevel), [motionLevel])
  const fadeVariants = useMemo(() => getPreset('fade', motionLevel), [motionLevel])

  const visibleSlice = useMemo(
    () => rows.slice(startIndex, endIndex),
    [rows, startIndex, endIndex],
  )

  const handleRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTableRowElement>, row: T, index: number) => {
      if (!onRowClick) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onRowClick(row, index)
      }
    },
    [onRowClick],
  )

  const activeBarKey = hoveredKey ?? selectedKey

  const wrapperStyle: CSSProperties = {
    width: '100%',
    minWidth: 0,
    maxWidth: '100%',
    overflowX: 'auto',
    ...(isVirtualized
      ? {
          overflowY: 'auto',
          maxHeight: virtualMaxHeight,
        }
      : {}),
    ...style,
  }

  return (
    <div
      ref={scrollContainerRef}
      onScroll={isVirtualized ? handleScroll : undefined}
      onPointerLeave={() => setHoveredKey(null)}
      className={className}
      style={wrapperStyle}
      data-virtualized={isVirtualized ? 'true' : 'false'}
    >
      <table
        aria-label={ariaLabel}
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          borderSpacing: 0,
          tableLayout: isVirtualized ? 'fixed' : 'auto',
        }}
      >
        {caption !== undefined && (
          <caption
            style={{
              textAlign: 'left',
              padding: '0 0 var(--sp-2) 0',
              fontSize: 'var(--fs-small)',
              color: 'var(--text-2)',
            }}
          >
            {caption}
          </caption>
        )}

        <thead>
          <tr>
            {columns.map((col) => {
              const align = resolveAlignment(col)
              return (
                <th
                  key={col.key}
                  scope="col"
                  className={col.headerClassName}
                  style={{
                    ...HEADER_CELL_BASE_STYLE,
                    textAlign: align,
                    width: col.width,
                    position: isVirtualized ? 'sticky' : undefined,
                    top: isVirtualized ? 0 : undefined,
                    zIndex: isVirtualized ? 2 : undefined,
                  }}
                >
                  {col.header}
                </th>
              )
            })}
          </tr>
        </thead>

        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={Math.max(1, columns.length)}
                style={{
                  padding: 'var(--sp-8) var(--sp-4)',
                  textAlign: 'center',
                  color: 'var(--text-3)',
                  fontSize: 'var(--fs-small)',
                }}
              >
                {emptyState ?? '暂无记录'}
              </td>
            </tr>
          ) : (
            <>
              {topSpacerHeight > 0 && (
                <tr aria-hidden="true">
                  <td
                    colSpan={Math.max(1, columns.length)}
                    style={{ height: topSpacerHeight, padding: 0, border: 0 }}
                  />
                </tr>
              )}

              {visibleSlice.map((row, sliceIdx) => {
                const absoluteIndex = startIndex + sliceIdx
                const key = getRowKey(row, absoluteIndex)
                const isHovered = hoveredKey === key
                const isSelected = selectedKey !== null && selectedKey === key
                const isActiveBar = activeBarKey === key
                const tone = rowTone?.(row, absoluteIndex) ?? 'default'
                const hasToneBar = tone !== 'default'
                const shouldBloom = !hasScrolled && absoluteIndex < STAGGER.listMax
                const rowVariants = shouldBloom ? bloomVariants : fadeVariants
                const staggerDelay = listStaggerDelay(absoluteIndex)
                const isClickable = onRowClick !== undefined

                return (
                  <motion.tr
                    key={key}
                    variants={hasScrolled ? undefined : rowVariants}
                    initial={hasScrolled ? false : 'initial'}
                    animate={hasScrolled ? undefined : 'animate'}
                    custom={staggerDelay}
                    onPointerEnter={() => setHoveredKey(key)}
                    onFocus={() => setHoveredKey(key)}
                    onBlur={() => {
                      setHoveredKey((prev) => (prev === key ? null : prev))
                    }}
                    onClick={isClickable ? () => onRowClick(row, absoluteIndex) : undefined}
                    onKeyDown={isClickable ? (e) => handleRowKeyDown(e, row, absoluteIndex) : undefined}
                    tabIndex={isClickable ? 0 : undefined}
                    aria-selected={selectedKey !== null ? isSelected : undefined}
                    data-row-key={String(key)}
                    style={{
                      height: `${rowHeight}px`,
                      background: isHovered || isSelected ? 'var(--plate-raised)' : 'transparent',
                      cursor: isClickable ? 'pointer' : undefined,
                      transition: `background-color ${DUR.quick}s ease`,
                    }}
                  >
                    {columns.map((col, colIdx) => {
                      const align = resolveAlignment(col)
                      const isFirstCol = colIdx === 0
                      const isNumeric = col.numeric === true
                      const cellClasses = [isNumeric ? 'num' : '', col.cellClassName ?? '']
                        .filter(Boolean)
                        .join(' ')

                      return (
                        <td
                          key={col.key}
                          className={cellClasses || undefined}
                          style={{
                            position: isFirstCol ? 'relative' : undefined,
                            height: `${rowHeight}px`,
                            padding: '0 var(--sp-4)',
                            textAlign: align,
                            verticalAlign: 'middle',
                            fontSize: isNumeric ? 'var(--fs-mono)' : 'var(--fs-body)',
                            lineHeight: isNumeric ? 'var(--lh-mono)' : 'var(--lh-body)',
                            color: 'var(--text-1)',
                            borderBottom: isSelected
                              ? '1px solid var(--hair-strong)'
                              : '1px solid var(--hair)',
                            overflow: isVirtualized ? 'hidden' : undefined,
                            textOverflow: isVirtualized ? 'ellipsis' : undefined,
                            whiteSpace: isVirtualized ? 'nowrap' : undefined,
                          }}
                        >
                          {isFirstCol && hasToneBar && !isActiveBar && (
                            <span
                              aria-hidden="true"
                              style={{
                                position: 'absolute',
                                left: 0,
                                top: 0,
                                bottom: 0,
                                width: '2px',
                                background: TONE_INDICATOR_COLOR[tone],
                                pointerEvents: 'none',
                              }}
                            />
                          )}

                          {isFirstCol && isActiveBar && (
                            <motion.span
                              aria-hidden="true"
                              layoutId={motionLevel === 'full' ? indicatorLayoutId : undefined}
                              transition={motionLevel === 'full' ? SPRING.snappy : { duration: 0 }}
                              style={{
                                position: 'absolute',
                                left: 0,
                                top: 0,
                                bottom: 0,
                                width: '2px',
                                background: TONE_INDICATOR_COLOR[tone],
                                pointerEvents: 'none',
                              }}
                            />
                          )}

                          {col.render(row, absoluteIndex)}
                        </td>
                      )
                    })}
                  </motion.tr>
                )
              })}

              {bottomSpacerHeight > 0 && (
                <tr aria-hidden="true">
                  <td
                    colSpan={Math.max(1, columns.length)}
                    style={{ height: bottomSpacerHeight, padding: 0, border: 0 }}
                  />
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>
    </div>
  )
}
