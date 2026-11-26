import { useEffect, useState, type CSSProperties } from 'react'
import { inktideStore, useInktideStore, type ThemeMode } from '../data/store.ts'
import { useInk } from '../ink/InkProvider.tsx'

interface SwatchDef {
  readonly variable: string
  readonly name: string
  readonly note: string
  readonly isZhusha?: boolean
}

interface SwatchGroup {
  readonly id: string
  readonly label: string
  readonly title: string
  readonly note?: string
  readonly items: readonly SwatchDef[]
}

const SWATCH_GROUPS: readonly SwatchGroup[] = [
  {
    id: 'ink-plate',
    label: 'INK · PLATES',
    title: '墨与纸版',
    items: [
      { variable: '--ink-void', name: '深砚', note: '流体最下层色' },
      { variable: '--ink-stone', name: '砚石', note: '界面主色' },
      { variable: '--plate', name: '纸版', note: '实色卡片' },
      { variable: '--plate-raised', name: '高起纸版', note: '展开层与表层' },
      { variable: '--plate-sunken', name: '内收纸版', note: '输入与数据区' },
      { variable: '--hair', name: '细线', note: '分隔与格线' },
      { variable: '--hair-strong', name: '强线', note: '表头与选中边线' },
      { variable: '--text-1', name: '正文墨', note: '标题与正文' },
      { variable: '--text-2', name: '次墨', note: '次要说明' },
      { variable: '--text-3', name: '淡墨文', note: '时间与提示' },
      { variable: '--smoke', name: '流体墨色', note: '夜为白光、日为墨' },
    ],
  },
  {
    id: 'pigments',
    label: 'MINERAL PIGMENTS',
    title: '国画色料',
    note: '朱砂每界最多 3 处（圆相、主入口、当前焦点）；状态色只用于状态。',
    items: [
      { variable: '--zhusha', name: '朱砂', note: '主强调色 · 最多 3 处', isZhusha: true },
      { variable: '--zhusha-deep', name: '深朱砂', note: '按下与印面深处' },
      { variable: '--zhusha-glow', name: '朱砂光', note: '克制光影' },
      { variable: '--tenghuang', name: '藤黄', note: '慎示、待确认、遗忘预览' },
      { variable: '--shilv', name: '石绿', note: '达成、正常、已启用' },
      { variable: '--shiqing', name: '石青', note: '说明、连通、多通道' },
      { variable: '--yanzhi', name: '胭脂', note: '失误、异常、中断' },
    ],
  },
  {
    id: 'strata',
    label: 'MEMORY · STRATA',
    title: '墨阶 L0–L3',
    note: '记忆分层用墨的浓淡区分，L3 焦墨加朱印。',
    items: [
      { variable: '--tone-l0', name: 'L0 · 淡墨', note: '原始事件 · 2.5px' },
      { variable: '--tone-l1', name: 'L1 · 中墨', note: '事实与事件 · 4px' },
      { variable: '--tone-l2', name: 'L2 · 浓墨', note: '场记与反思 · 6px' },
      { variable: '--tone-l3', name: 'L3 · 焦墨朱印', note: '本心主位 · 11px' },
    ],
  },
]

const ALL_SWATCH_VARS: readonly string[] = SWATCH_GROUPS.flatMap((g) =>
  g.items.map((item) => item.variable),
)

interface TypeStep {
  readonly token: string
  readonly spec: string
  readonly sample: string
  readonly style: CSSProperties
  readonly extraClass?: string
}

const TYPE_SCALE: readonly TypeStep[] = [
  {
    token: '--fs-hero',
    spec: '88 / 92 px · Noto Serif SC 900 · -0.02em',
    sample: '小鲸鱼',
    style: {
      fontFamily: 'var(--font-display-cjk)',
      fontSize: 'var(--fs-hero)',
      lineHeight: 'var(--lh-hero)',
      fontWeight: 900,
      letterSpacing: '-0.02em',
      color: 'var(--text-1)',
    },
  },
  {
    token: '--fs-display',
    spec: '56 / 60 px · Noto Serif SC 900 · -0.015em',
    sample: '墨谱',
    style: {
      fontFamily: 'var(--font-display-cjk)',
      fontSize: 'var(--fs-display)',
      lineHeight: 'var(--lh-display)',
      fontWeight: 900,
      letterSpacing: '-0.015em',
      color: 'var(--text-1)',
    },
  },
  {
    token: '--fs-h1',
    spec: '32 / 38 px · Noto Serif SC 700 · -0.01em',
    sample: '墨潮 · 记忆、印谱与夜墨',
    style: {
      fontFamily: 'var(--font-display-cjk)',
      fontSize: 'var(--fs-h1)',
      lineHeight: 'var(--lh-h1)',
      fontWeight: 700,
      letterSpacing: '-0.01em',
      color: 'var(--text-1)',
    },
  },
  {
    token: '--fs-h2',
    spec: '20 / 28 px · UI 600',
    sample: '夜墨与宣纸 · 实色纸版与明快格线',
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--fs-h2)',
      lineHeight: 'var(--lh-h2)',
      fontWeight: 600,
      color: 'var(--text-1)',
    },
  },
  {
    token: '--fs-body',
    spec: '15 / 24 px · UI 400',
    sample: '所有正文放在实色纸版上，令牌只驻留内存，刷新即清。',
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--fs-body)',
      lineHeight: 'var(--lh-body)',
      fontWeight: 400,
      color: 'var(--text-1)',
    },
  },
  {
    token: '--fs-small',
    spec: '13 / 20 px · UI 400 · 0.01em',
    sample: '次要状态说明 · 多通道模式 · 离线书体与质感检验',
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--fs-small)',
      lineHeight: 'var(--lh-small)',
      fontWeight: 400,
      letterSpacing: '0.01em',
      color: 'var(--text-2)',
    },
  },
  {
    token: '--fs-mono',
    spec: '12.5 / 18 px · JetBrains Mono 450 · tabular-nums',
    sample: 'L2 · rec_01J9XK8M · 2026-11-22 21:00:00 · 18,200 / 60,000 tok · ¥0.83',
    extraClass: 'num',
    style: {
      fontSize: 'var(--fs-mono)',
      lineHeight: 'var(--lh-mono)',
      fontWeight: 450,
      color: 'var(--text-1)',
    },
  },
  {
    token: '--fs-label',
    spec: '11 / 14 px · JetBrains Mono 600 · 0.14em uppercase',
    sample: 'MEMORY · STRATA · COURT · SEALS · PULSE',
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-label)',
      lineHeight: 'var(--lh-label)',
      fontWeight: 600,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: 'var(--text-2)',
    },
  },
  {
    token: '--fs-num-xl',
    spec: '64 / 64 px · Fraunces Variable (wght 300 opsz 144) · -0.03em · tabular-nums',
    sample: '12,480 · ¥0.83 · 98.4%',
    style: {
      fontFamily: 'var(--font-display-latin)',
      fontSize: 'var(--fs-num-xl)',
      lineHeight: 'var(--lh-num-xl)',
      fontWeight: 300,
      fontVariationSettings: '"opsz" 144, "SOFT" 50, "WONK" 0',
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '-0.03em',
      color: 'var(--text-1)',
    },
  },
]

interface FontAuditRow {
  readonly id: string
  readonly family: string
  readonly weightLabel: string
  readonly query: string
  readonly status: string
}

const FONT_TARGETS: readonly Omit<FontAuditRow, 'status'>[] = [
  {
    id: 'noto-700',
    family: 'Noto Serif SC Inktide',
    weightLabel: '700 (Bold)',
    query: '700 32px "Noto Serif SC Inktide"',
  },
  {
    id: 'noto-900',
    family: 'Noto Serif SC Inktide',
    weightLabel: '900 (Heavy)',
    query: '900 56px "Noto Serif SC Inktide"',
  },
  {
    id: 'fraunces',
    family: 'Fraunces Inktide',
    weightLabel: '100–900 (Variable)',
    query: '300 64px "Fraunces Inktide"',
  },
  {
    id: 'jetbrains',
    family: 'JetBrains Mono Inktide',
    weightLabel: '100–800 (Variable · tabular-nums)',
    query: '450 12.5px "JetBrains Mono Inktide"',
  },
]

function inspectFontStatuses(): readonly FontAuditRow[] {
  if (typeof document === 'undefined' || typeof document.fonts === 'undefined') {
    return FONT_TARGETS.map((target) => ({ ...target, status: 'unavailable' }))
  }
  const faces = Array.from(document.fonts)
  return FONT_TARGETS.map((target) => {
    const cleanFamily = target.family.toLowerCase()
    const matching = faces.filter((face) =>
      face.family.replace(/^["']|["']$/g, '').toLowerCase() === cleanFamily,
    )
    let matchedFace: FontFace | undefined
    if (target.id === 'noto-700') {
      matchedFace = matching.find((f) => String(f.weight) === '700')
    } else if (target.id === 'noto-900') {
      matchedFace = matching.find((f) => String(f.weight) === '900')
    } else {
      matchedFace = matching[0]
    }
    const isChecked = document.fonts.check(target.query)
    const status = matchedFace !== undefined
      ? matchedFace.status
      : (isChecked ? 'loaded' : 'unloaded')
    return { ...target, status }
  })
}

function readComputedTokens(): Readonly<Record<string, string>> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return {}
  const styles = window.getComputedStyle(document.documentElement)
  const map: Record<string, string> = {}
  for (const varName of ALL_SWATCH_VARS) {
    map[varName] = styles.getPropertyValue(varName).trim()
  }
  map['--texture'] = styles.getPropertyValue('--texture').trim()
  map['--texture-opacity'] = styles.getPropertyValue('--texture-opacity').trim()
  map['--radius'] = styles.getPropertyValue('--radius').trim()
  return map
}

const THEME_OPTIONS: readonly { readonly mode: ThemeMode; readonly label: string }[] = [
  { mode: 'night', label: '夜墨' },
  { mode: 'paper', label: '宣纸' },
  { mode: 'auto', label: '自动' },
]

export function DevTokensPage() {
  const themeMode = useInktideStore((s) => s.themeMode)
  const resolvedTheme = useInktideStore((s) => s.resolvedTheme)
  const ink = useInk()

  const [computed, setComputed] = useState<Readonly<Record<string, string>>>(() => readComputedTokens())
  const [fontRows, setFontRows] = useState<readonly FontAuditRow[]>(() => inspectFontStatuses())

  useEffect(() => {
    ink.setCalm(true)
    return () => {
      ink.setCalm(false)
    }
  }, [ink])

  useEffect(() => {
    setComputed(readComputedTokens())
  }, [resolvedTheme, themeMode])

  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.fonts === 'undefined') return
    let active = true
    const refresh = (): void => {
      if (active) setFontRows(inspectFontStatuses())
    }
    refresh()
    void Promise.allSettled(FONT_TARGETS.map((t) => document.fonts.load(t.query))).then(refresh)
    void document.fonts.ready.then(refresh)
    document.fonts.addEventListener('loadingdone', refresh)
    return () => {
      active = false
      document.fonts.removeEventListener('loadingdone', refresh)
    }
  }, [])

  return (
    <div
      className="min-h-screen w-full"
      style={{
        padding: 'var(--sp-6) var(--sp-8) var(--sp-10)',
        maxWidth: '1440px',
        margin: '0 auto',
      }}
    >
      {/* Top Lockup & Controls */}
      <header className="flex flex-wrap items-start justify-between gap-6 mb-10">
        <div>
          <div className="label">DEV · TOKENS</div>
          <h1 className="title-display mt-2 mb-0">墨谱</h1>
        </div>

        <div
          className="plate flex flex-wrap items-center gap-3 px-4 py-2.5"
          style={{ border: '1px solid var(--hair)' }}
        >
          <span
            className="num text-xs"
            style={{ color: 'var(--text-3)' }}
            data-testid="resolved-theme-badge"
          >
            data-theme=&quot;{resolvedTheme}&quot;
          </span>

          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="主题切选"
            style={{
              background: 'var(--plate-sunken)',
              padding: '2px',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--hair)',
            }}
          >
            {THEME_OPTIONS.map((opt) => {
              const active = themeMode === opt.mode
              return (
                <button
                  key={opt.mode}
                  type="button"
                  data-testid={`theme-${opt.mode}`}
                  aria-pressed={active}
                  onClick={() => inktideStore.setThemeMode(opt.mode)}
                  className="px-3 py-1 cursor-pointer"
                  style={{
                    fontSize: 'var(--fs-small)',
                    lineHeight: 'var(--lh-small)',
                    border: 0,
                    borderRadius: 'var(--radius)',
                    background: active ? 'var(--zhusha)' : 'transparent',
                    color: active ? 'var(--plate)' : 'var(--text-2)',
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>

          <a
            href="#dev/ink"
            data-testid="nav-dev-ink"
            onClick={(e) => {
              e.preventDefault()
              inktideStore.setRoute('dev/ink')
            }}
            className="px-3 py-1"
            style={{
              fontSize: 'var(--fs-small)',
              lineHeight: 'var(--lh-small)',
              background: 'var(--plate-raised)',
              color: 'var(--text-1)',
              border: '1px solid var(--hair-strong)',
              borderRadius: 'var(--radius)',
              textDecoration: 'none',
            }}
          >
            墨潮 #dev/ink
          </a>
        </div>
      </header>

      <main className="flex flex-col gap-8">
        {/* Section 1: Color Swatches */}
        <section className="flex flex-col gap-6" aria-label="色卡">
          {SWATCH_GROUPS.map((group) => (
            <div
              key={group.id}
              className="plate p-6"
              style={{ border: '1px solid var(--hair)' }}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-4 mb-5">
                <div>
                  <div
                    className="num"
                    style={{
                      fontSize: 'var(--fs-label)',
                      lineHeight: 'var(--lh-label)',
                      letterSpacing: '0.14em',
                      color: 'var(--text-3)',
                    }}
                  >
                    {group.label}
                  </div>
                  <h2
                    className="mt-1 mb-0"
                    style={{
                      fontFamily: 'var(--font-display-cjk)',
                      fontSize: 'var(--fs-h1)',
                      lineHeight: 'var(--lh-h1)',
                      fontWeight: 700,
                      color: 'var(--text-1)',
                    }}
                  >
                    {group.title}
                  </h2>
                </div>
                {group.note !== undefined && (
                  <p
                    className="m-0"
                    style={{
                      fontSize: 'var(--fs-small)',
                      lineHeight: 'var(--lh-small)',
                      color: 'var(--text-2)',
                    }}
                  >
                    {group.note}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
                {group.items.map((swatch) => {
                  const liveValue = computed[swatch.variable] ?? ''
                  return (
                    <div
                      key={swatch.variable}
                      data-testid={`swatch-${swatch.variable.slice(2)}`}
                      className="flex flex-col gap-2 p-3"
                      style={{
                        background: 'var(--plate-sunken)',
                        border: swatch.isZhusha === true
                          ? '1px solid var(--zhusha)'
                          : '1px solid var(--hair)',
                        borderRadius: 'var(--radius)',
                      }}
                    >
                      <div
                        className="w-full h-14"
                        style={{
                          background: `var(${swatch.variable})`,
                          border: '1px solid var(--hair-strong)',
                          borderRadius: 'var(--radius)',
                        }}
                      />
                      <div className="flex items-center justify-between gap-2">
                        <span
                          style={{
                            fontSize: 'var(--fs-small)',
                            fontWeight: 600,
                            color: 'var(--text-1)',
                          }}
                        >
                          {swatch.name}
                        </span>
                        {swatch.isZhusha === true && (
                          <span
                            className="num px-1.5 py-0.5"
                            style={{
                              fontSize: 'var(--fs-label)',
                              border: '1px solid var(--zhusha)',
                              color: 'var(--zhusha)',
                              borderRadius: 'var(--radius)',
                            }}
                          >
                            ≤3
                          </span>
                        )}
                      </div>
                      <code
                        className="num block truncate"
                        style={{
                          fontSize: 'var(--fs-mono)',
                          color: 'var(--text-2)',
                        }}
                      >
                        {swatch.variable}
                      </code>
                      <code
                        className="num block truncate"
                        style={{
                          fontSize: 'var(--fs-label)',
                          color: 'var(--text-3)',
                        }}
                        title={liveValue}
                      >
                        {liveValue || '—'}
                      </code>
                      <span
                        style={{
                          fontSize: 'var(--fs-small)',
                          lineHeight: 'var(--lh-small)',
                          color: 'var(--text-3)',
                        }}
                      >
                        {swatch.note}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </section>

        {/* Section 2: Typography Scale */}
        <section
          className="plate p-6"
          style={{ border: '1px solid var(--hair)' }}
          aria-label="书体与号级"
        >
          <div className="mb-6">
            <div
              className="num"
              style={{
                fontSize: 'var(--fs-label)',
                lineHeight: 'var(--lh-label)',
                letterSpacing: '0.14em',
                color: 'var(--text-3)',
              }}
            >
              TYPOGRAPHY · SCALE
            </div>
            <h2
              className="mt-1 mb-0"
              style={{
                fontFamily: 'var(--font-display-cjk)',
                fontSize: 'var(--fs-h1)',
                lineHeight: 'var(--lh-h1)',
                fontWeight: 700,
                color: 'var(--text-1)',
              }}
            >
              书体与号级
            </h2>
          </div>

          <div className="flex flex-col">
            {TYPE_SCALE.map((row, idx) => (
              <div
                key={row.token}
                className="grid grid-cols-1 lg:grid-cols-12 gap-3 py-4 items-baseline"
                style={{
                  borderTop: idx === 0 ? '1px solid var(--hair-strong)' : '1px solid var(--hair)',
                }}
              >
                <div className="lg:col-span-3 flex flex-col gap-1">
                  <code
                    className="num"
                    style={{ fontSize: 'var(--fs-mono)', color: 'var(--text-1)' }}
                  >
                    {row.token}
                  </code>
                  <span
                    className="num"
                    style={{ fontSize: 'var(--fs-label)', color: 'var(--text-3)' }}
                  >
                    {row.spec}
                  </span>
                </div>
                <div className={`lg:col-span-9 overflow-x-auto ${row.extraClass ?? ''}`} style={row.style}>
                  {row.sample}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Section 3: Plates & Procedural Textures */}
        <section
          className="plate p-6"
          style={{ border: '1px solid var(--hair)' }}
          aria-label="纸版与质感"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-4 mb-6">
            <div>
              <div
                className="num"
                style={{
                  fontSize: 'var(--fs-label)',
                  lineHeight: 'var(--lh-label)',
                  letterSpacing: '0.14em',
                  color: 'var(--text-3)',
                }}
              >
                PLATES · PROCEDURAL TEXTURES
              </div>
              <h2
                className="mt-1 mb-0"
                style={{
                  fontFamily: 'var(--font-display-cjk)',
                  fontSize: 'var(--fs-h1)',
                  lineHeight: 'var(--lh-h1)',
                  fontWeight: 700,
                  color: 'var(--text-1)',
                }}
              >
                纸版与石纸质感
              </h2>
            </div>
            <div className="num flex flex-wrap gap-4" style={{ fontSize: 'var(--fs-mono)', color: 'var(--text-2)' }}>
              <span>--radius: {computed['--radius'] || '2px'}</span>
              <span>--texture: {computed['--texture'] || '—'}</span>
              <span>--texture-opacity: {computed['--texture-opacity'] || '—'}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <div
              className="plate p-5 flex flex-col justify-between min-h-40"
              style={{ border: '1px solid var(--hair)' }}
            >
              <div>
                <div className="num" style={{ fontSize: 'var(--fs-label)', color: 'var(--text-3)' }}>
                  LEVEL · BASE
                </div>
                <div
                  className="mt-2"
                  style={{ fontSize: 'var(--fs-h2)', fontWeight: 600, color: 'var(--text-1)' }}
                >
                  标准纸版
                </div>
              </div>
              <p className="m-0 num" style={{ fontSize: 'var(--fs-mono)', color: 'var(--text-2)' }}>
                --plate · --shadow-plate
              </p>
            </div>

            <div
              className="plate p-5 flex flex-col justify-between min-h-40"
              style={{
                background: 'var(--plate-raised)',
                boxShadow: 'var(--shadow-raised)',
                border: '1px solid var(--hair-strong)',
              }}
            >
              <div>
                <div className="num" style={{ fontSize: 'var(--fs-label)', color: 'var(--text-3)' }}>
                  LEVEL · RAISED
                </div>
                <div
                  className="mt-2"
                  style={{ fontSize: 'var(--fs-h2)', fontWeight: 600, color: 'var(--text-1)' }}
                >
                  高起纸版
                </div>
              </div>
              <p className="m-0 num" style={{ fontSize: 'var(--fs-mono)', color: 'var(--text-2)' }}>
                --plate-raised · --shadow-raised
              </p>
            </div>

            <div
              className="p-5 flex flex-col justify-between min-h-40"
              style={{
                background: 'var(--plate-sunken)',
                border: '1px solid var(--hair)',
                borderRadius: 'var(--radius)',
              }}
            >
              <div>
                <div className="num" style={{ fontSize: 'var(--fs-label)', color: 'var(--text-3)' }}>
                  LEVEL · SUNKEN
                </div>
                <div
                  className="mt-2"
                  style={{ fontSize: 'var(--fs-h2)', fontWeight: 600, color: 'var(--text-1)' }}
                >
                  内收纸版
                </div>
              </div>
              <p className="m-0 num" style={{ fontSize: 'var(--fs-mono)', color: 'var(--text-2)' }}>
                --plate-sunken · 0 shadow
              </p>
            </div>

            <div
              className="p-5 flex flex-col justify-between min-h-40"
              style={{
                background: 'var(--plate-sunken)',
                border: '1px solid var(--hair)',
                borderRadius: 'var(--radius)',
              }}
            >
              <div className="num mb-2" style={{ fontSize: 'var(--fs-label)', color: 'var(--text-3)' }}>
                256×256 TILE PREVIEW
              </div>
              <div
                className="w-full h-24"
                style={{
                  backgroundImage: 'var(--texture)',
                  backgroundSize: '128px 128px',
                  border: '1px solid var(--hair-strong)',
                  borderRadius: 'var(--radius)',
                }}
              />
              <span className="num mt-2" style={{ fontSize: 'var(--fs-label)', color: 'var(--text-2)' }}>
                {resolvedTheme === 'paper' ? 'paper-fiber.png (0.06)' : 'inkstone.png (0.035)'}
              </span>
            </div>
          </div>
        </section>

        {/* Section 4: Offline Font Status */}
        <section
          className="plate p-6"
          style={{ border: '1px solid var(--hair)' }}
          aria-label="离线书体状态"
        >
          <div className="mb-5">
            <div
              className="num"
              style={{
                fontSize: 'var(--fs-label)',
                lineHeight: 'var(--lh-label)',
                letterSpacing: '0.14em',
                color: 'var(--text-3)',
              }}
            >
              OFFLINE FONTS · DOCUMENT.FONTS
            </div>
            <h2
              className="mt-1 mb-0"
              style={{
                fontFamily: 'var(--font-display-cjk)',
                fontSize: 'var(--fs-h1)',
                lineHeight: 'var(--lh-h1)',
                fontWeight: 700,
                color: 'var(--text-1)',
              }}
            >
              离线书体状态
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {fontRows.map((row) => {
              const isLoaded = row.status === 'loaded'
              return (
                <div
                  key={row.id}
                  data-testid={`font-status-${row.id}`}
                  className="p-4 flex flex-col gap-2"
                  style={{
                    background: 'var(--plate-sunken)',
                    border: '1px solid var(--hair)',
                    borderRadius: 'var(--radius)',
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      style={{
                        fontSize: 'var(--fs-small)',
                        fontWeight: 600,
                        color: 'var(--text-1)',
                      }}
                    >
                      {row.family}
                    </span>
                    <span
                      className="num px-2 py-0.5"
                      style={{
                        fontSize: 'var(--fs-label)',
                        color: isLoaded ? 'var(--shilv)' : 'var(--tenghuang)',
                        border: isLoaded ? '1px solid var(--shilv)' : '1px solid var(--tenghuang)',
                        borderRadius: 'var(--radius)',
                      }}
                    >
                      {row.status}
                    </span>
                  </div>
                  <span className="num" style={{ fontSize: 'var(--fs-mono)', color: 'var(--text-2)' }}>
                    {row.weightLabel}
                  </span>
                  <span className="num" style={{ fontSize: 'var(--fs-label)', color: 'var(--text-3)' }}>
                    0123456789 · AaBb
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      </main>
    </div>
  )
}
