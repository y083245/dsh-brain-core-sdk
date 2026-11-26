import { ERROR_CODES, type Envelope, type ErrorCode, type Meta } from '@brain-core/sdk'

export interface ApiFetchOptions {
  readonly token?: string
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly body?: unknown
  readonly ifMatch?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly fetchImpl?: typeof globalThis.fetch
}

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T; readonly meta: Meta }
  | {
      readonly ok: false
      readonly status: number
      readonly code: ErrorCode
      readonly message: string
      readonly details: Readonly<Record<string, unknown>>
      readonly requestId?: string
    }

/** Unauthenticated requests are told apart from other transport trouble; the console shows the login box for them. */
const UNAUTHENTICATED_STATUS = 401

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (!isRecord(value)) return false
  if (value.ok === true) return 'data' in value && isRecord(value.meta)
  if (value.ok === false) {
    const error = value.error
    if (!isRecord(error) || typeof error.code !== 'string') return false
    return typeof error.message === 'string' && (error.details === undefined || isRecord(error.details))
  }
  return false
}

function failure(status: number, code: ErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}): ApiResult<never> {
  return { ok: false, status, code, message, details }
}

function headersOf(options: ApiFetchOptions): Record<string, string> {
  const headers: Record<string, string> = { ...options.headers }
  if (options.token !== undefined && options.token !== '') headers.Authorization = `Bearer ${options.token}`
  if (options.ifMatch !== undefined) headers['If-Match'] = String(options.ifMatch)
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  return headers
}

/** Rejected bodies never borrow `message` from a non-Error rejection: it could carry request text. */
function networkMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'network error'
}

/**
 * One request against the kernel's envelope API. Never throws: transport trouble, a timeout and a body that
 * is not an envelope all come back as `{ ok: false, code: 'UNAVAILABLE' }`, and a business failure is
 * reported by `error.code` alone (FR-C01).
 */
export async function apiFetch<T>(url: string, options: ApiFetchOptions = {}): Promise<ApiResult<T>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const headers = headersOf(options)
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }

  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    return failure(0, 'UNAVAILABLE', networkMessage(error))
  }

  let text: string
  try {
    text = await response.text()
  } catch (error) {
    return failure(response.status, 'UNAVAILABLE', networkMessage(error))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }

  if (isEnvelope(parsed)) {
    if (parsed.ok) return { ok: true, status: response.status, data: parsed.data as T, meta: parsed.meta }
    const raw = parsed.error
    const code = Object.hasOwn(ERROR_CODES, raw.code) ? (raw.code as ErrorCode) : 'INTERNAL'
    return {
      ok: false,
      status: response.status,
      code,
      message: raw.message,
      details: raw.details ?? {},
      ...(parsed.meta?.requestId === undefined ? {} : { requestId: parsed.meta.requestId }),
    }
  }

  // Not an envelope: keep whatever the transport told us, and only 401 gets to skip the default code.
  const status = response.status
  const code: ErrorCode = status === UNAUTHENTICATED_STATUS ? 'UNAUTHENTICATED' : 'UNAVAILABLE'
  const message = parsed === undefined ? `non-JSON response (HTTP ${String(status)})` : 'response is not an envelope'
  return failure(status, code, message)
}
