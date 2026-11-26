import { useCallback, useEffect, useRef, useState } from 'react'

export const POLL_INTERVALS = {
  satelliteActivePulseMs: 2_000,
  satelliteActiveOtherMs: 5_000,
  satelliteBackgroundMs: 10_000,
  accountingActiveMs: 30_000,
  accountingBackgroundMs: 60_000,
  chatActiveMs: 2_000,
  memoryActiveMs: 10_000,
  proposalsActiveMs: 30_000,
  proposalsBackgroundMs: 120_000,
  pluginsActiveMs: 15_000,
  pluginsBackgroundMs: 120_000,
} as const

export const COURT_POLL_INTERVALS = {
  proposalsMs: 60_000,
  pluginsMs: 60_000,
} as const

export interface PollingTimers {
  readonly setTimeout: (callback: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

export interface PollingState<T> {
  readonly data: T | undefined
  readonly error: unknown
  readonly loading: boolean
  readonly lastUpdatedAt: number | null
}

export interface PollingControllerOptions<T> {
  readonly fetcher: (signal?: AbortSignal) => Promise<T>
  readonly intervalMs: number
  readonly enabled?: boolean
  readonly immediate?: boolean
  readonly onData?: (data: T) => void
  readonly onError?: (err: unknown) => void
  readonly onStateChange?: (state: PollingState<T>) => void
  readonly isVisible?: () => boolean
  readonly subscribeVisibility?: (listener: () => void) => () => void
  readonly timers?: PollingTimers
  readonly now?: () => number
}

export interface PollingController<T> {
  start(): void
  stop(): void
  refresh(): Promise<T | undefined>
  setEnabled(enabled: boolean): void
  setIntervalMs(intervalMs: number): void
  getState(): PollingState<T>
  dispose(): void
}

interface MinimalVisibilityDocument {
  readonly visibilityState?: string
  addEventListener?(type: 'visibilitychange', listener: () => void): void
  removeEventListener?(type: 'visibilitychange', listener: () => void): void
}

function getGlobalDocument(): MinimalVisibilityDocument | undefined {
  const doc = (globalThis as { readonly document?: unknown }).document
  if (typeof doc === 'object' && doc !== null) {
    return doc as MinimalVisibilityDocument
  }
  return undefined
}

function defaultIsVisible(): boolean {
  const doc = getGlobalDocument()
  return doc?.visibilityState !== 'hidden'
}

function defaultSubscribeVisibility(listener: () => void): () => void {
  const doc = getGlobalDocument()
  if (doc === undefined || typeof doc.addEventListener !== 'function') {
    return () => {}
  }
  doc.addEventListener('visibilitychange', listener)
  return () => {
    doc.removeEventListener?.('visibilitychange', listener)
  }
}

const DEFAULT_TIMERS: PollingTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  },
}

export function createPollingController<T>(
  options: PollingControllerOptions<T>,
): PollingController<T> {
  const isVisible = options.isVisible ?? defaultIsVisible
  const subscribeVisibility = options.subscribeVisibility ?? defaultSubscribeVisibility
  const timers = options.timers ?? DEFAULT_TIMERS
  const now = options.now ?? (() => Date.now())
  const immediate = options.immediate ?? true

  let enabled = options.enabled ?? true
  let intervalMs = options.intervalMs
  let running = false
  let disposed = false
  let latestSeq = 0
  let timerHandle: unknown = null
  let unsubscribeVisibility: (() => void) | null = null
  let activeAbort: AbortController | null = null
  let wasVisible = isVisible()

  let state: PollingState<T> = {
    data: undefined,
    error: undefined,
    loading: false,
    lastUpdatedAt: null,
  }

  function setState(next: PollingState<T>): void {
    if (disposed) return
    state = next
    options.onStateChange?.(state)
  }

  function clearTimer(): void {
    if (timerHandle !== null) {
      timers.clearTimeout(timerHandle)
      timerHandle = null
    }
  }

  function detachVisibility(): void {
    if (unsubscribeVisibility !== null) {
      unsubscribeVisibility()
      unsubscribeVisibility = null
    }
  }

  function scheduleNext(): void {
    clearTimer()
    if (disposed || !running || !enabled || !isVisible()) return
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return

    timerHandle = timers.setTimeout(() => {
      timerHandle = null
      if (disposed || !running || !enabled || !isVisible()) return
      void runFetch()
    }, intervalMs)
  }

  async function runFetch(): Promise<T | undefined> {
    if (disposed) return undefined

    clearTimer()
    latestSeq += 1
    const seq = latestSeq

    activeAbort?.abort()
    const abortController = typeof AbortController === 'function' ? new AbortController() : null
    activeAbort = abortController

    setState({ ...state, loading: true })

    try {
      const data = await options.fetcher(abortController?.signal)
      if (disposed || seq !== latestSeq) {
        return undefined
      }
      if (activeAbort === abortController) {
        activeAbort = null
      }
      setState({
        data,
        error: undefined,
        loading: false,
        lastUpdatedAt: now(),
      })
      options.onData?.(data)
      if (!disposed && seq === latestSeq) {
        scheduleNext()
      }
      return data
    } catch (err) {
      if (disposed || seq !== latestSeq) {
        return undefined
      }
      if (activeAbort === abortController) {
        activeAbort = null
      }
      setState({
        ...state,
        error: err,
        loading: false,
      })
      options.onError?.(err)
      if (!disposed && seq === latestSeq) {
        scheduleNext()
      }
      return undefined
    }
  }

  function handleVisibilityChange(): void {
    if (disposed || !running) return
    const visible = isVisible()
    if (!visible) {
      wasVisible = false
      clearTimer()
      return
    }
    if (!wasVisible) {
      wasVisible = true
      if (enabled) {
        void runFetch()
      }
    }
  }

  function start(): void {
    if (disposed || running) return
    running = true
    wasVisible = isVisible()
    unsubscribeVisibility = subscribeVisibility(handleVisibilityChange)

    if (!enabled || !wasVisible) return
    if (immediate) {
      void runFetch()
    } else {
      scheduleNext()
    }
  }

  function stop(): void {
    if (!running) return
    running = false
    clearTimer()
    detachVisibility()
    latestSeq += 1
    activeAbort?.abort()
    activeAbort = null
    if (!disposed && state.loading) {
      setState({ ...state, loading: false })
    }
  }

  function setEnabled(nextEnabled: boolean): void {
    if (disposed || nextEnabled === enabled) return
    enabled = nextEnabled
    if (!enabled) {
      clearTimer()
      latestSeq += 1
      activeAbort?.abort()
      activeAbort = null
      if (state.loading) {
        setState({ ...state, loading: false })
      }
      return
    }
    if (running) {
      wasVisible = isVisible()
      if (wasVisible) {
        if (immediate) {
          void runFetch()
        } else {
          scheduleNext()
        }
      }
    }
  }

  function setIntervalMs(nextIntervalMs: number): void {
    if (disposed || nextIntervalMs === intervalMs) return
    intervalMs = nextIntervalMs
    if (running && enabled && isVisible() && timerHandle !== null) {
      scheduleNext()
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    running = false
    clearTimer()
    detachVisibility()
    latestSeq += 1
    activeAbort?.abort()
    activeAbort = null
  }

  return {
    start,
    stop,
    refresh: () => runFetch(),
    setEnabled,
    setIntervalMs,
    getState: () => state,
    dispose,
  }
}

export interface UsePollingOptions<T> {
  readonly enabled?: boolean
  readonly immediate?: boolean
  readonly onData?: (data: T) => void
  readonly onError?: (err: unknown) => void
}

export interface UsePollingResult<T> {
  readonly data: T | undefined
  readonly error: unknown
  readonly loading: boolean
  readonly lastUpdatedAt: number | null
  readonly refresh: () => Promise<T | undefined>
}

export function usePolling<T>(
  fetcher: (signal?: AbortSignal) => Promise<T>,
  intervalMs: number,
  options: UsePollingOptions<T> = {},
): UsePollingResult<T> {
  const { enabled = true, immediate = true, onData, onError } = options

  const fetcherRef = useRef(fetcher)
  const onDataRef = useRef(onData)
  const onErrorRef = useRef(onError)
  const controllerRef = useRef<PollingController<T> | null>(null)

  fetcherRef.current = fetcher
  onDataRef.current = onData
  onErrorRef.current = onError

  const [state, setState] = useState<PollingState<T>>({
    data: undefined,
    error: undefined,
    loading: enabled && immediate,
    lastUpdatedAt: null,
  })

  useEffect(() => {
    const controller = createPollingController<T>({
      fetcher: (signal) => fetcherRef.current(signal),
      intervalMs,
      enabled,
      immediate,
      onData: (data) => onDataRef.current?.(data),
      onError: (err) => onErrorRef.current?.(err),
      onStateChange: (nextState) => setState(nextState),
    })
    controllerRef.current = controller
    controller.start()

    return () => {
      controller.dispose()
      if (controllerRef.current === controller) {
        controllerRef.current = null
      }
    }
  }, [immediate])

  useEffect(() => {
    controllerRef.current?.setEnabled(enabled)
  }, [enabled])

  useEffect(() => {
    controllerRef.current?.setIntervalMs(intervalMs)
  }, [intervalMs])

  const refresh = useCallback((): Promise<T | undefined> => {
    return controllerRef.current?.refresh() ?? Promise.resolve(undefined)
  }, [])

  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    lastUpdatedAt: state.lastUpdatedAt,
    refresh,
  }
}
