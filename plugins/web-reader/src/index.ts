import { BrainError, type BrainContext, type PluginApply } from '@dsh-brain-core/sdk'
import type { WebReaderConfig } from './config.ts'
import { assertSafeFeedUrl } from './safe-url.ts'
import { extractAndSanitizeArticle } from './sanitize.ts'

export type { WebReaderConfig } from './config.ts'
export { assertSafeFeedUrl, isForbiddenHost } from './safe-url.ts'
export { extractAndSanitizeArticle, type CleanedArticle } from './sanitize.ts'

const CHANNEL = 'web-reader:feed:default'
const CURSOR_FILE = 'cursor.json'
const DEFAULT_MAX_BYTES = 262_144
const DEFAULT_MAX_CHARS = 4_000
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_EVERY_MS = 3_600_000

export interface ReadArticleResult {
  readonly url: string
  readonly title: string
  readonly l0Id: string
  readonly l1Id: string
  readonly truncated: boolean
}

/** Fetches one public feed URL, sanitizes its content, writes L0.3 + L1.7, and wakes the activity agent silently. */
export async function readOneArticle(
  ctx: BrainContext<WebReaderConfig>,
  url: string,
  config: WebReaderConfig = ctx.config,
): Promise<ReadArticleResult> {
  const feeds = config.feeds ?? []
  assertSafeFeedUrl(url, feeds)

  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const res = await ctx.http.fetch(url, { timeoutMs, maxBytes })
  if (res.status < 200 || res.status >= 300) {
    throw new BrainError('UNAVAILABLE', `feed returned status ${res.status}`)
  }
  if (res.bytes().byteLength > maxBytes) {
    throw new BrainError('PAYLOAD_TOO_LARGE', 'article exceeds maxBytes')
  }

  const { title, summary, quote, truncated } = extractAndSanitizeArticle(res.text(), maxChars)

  const l0 = await ctx.memory.ingest({
    kind: 'web-reader.article',
    channel: CHANNEL,
    subjects: ['self'],
    actor: 'web-reader',
    visibility: 'open',
    tEvent: Date.now(),
    idempotencyKey: `web-reader:l0:${url}`,
    content: { url, title, quote, truncated },
  })

  const l1 = await ctx.memory.record({
    layer: 'L1',
    kind: 'l1.knowledge',
    channel: CHANNEL,
    subjects: ['self'],
    actor: 'web-reader',
    visibility: 'open',
    confidence: 0.85,
    importance: 0.5,
    evidence: [{ id: l0.id }],
    idempotencyKey: `web-reader:l1:${url}`,
    content: { text: `读了《${title}》：${summary}`, url, title, summary, quote },
  })

  try {
    await ctx.agent.wake(CHANNEL, {
      reason: 'web-read',
      silent: true,
      evidence: [l0.id],
      note: quote,
    })
  } catch (error) {
    if (error instanceof BrainError && error.code === 'UNAVAILABLE') {
      ctx.logger.info('web_reader.wake_skipped', { url })
    } else {
      throw error
    }
  }

  return { url, title, l0Id: l0.id, l1Id: l1.id, truncated }
}

async function readCursor(ctx: BrainContext<WebReaderConfig>): Promise<number> {
  const raw = await ctx.storage.read(CURSOR_FILE)
  if (raw === undefined) return 0
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as { readonly index?: unknown }
    return typeof parsed.index === 'number' && Number.isInteger(parsed.index) && parsed.index >= 0
      ? parsed.index
      : 0
  } catch {
    return 0
  }
}

async function writeCursor(ctx: BrainContext<WebReaderConfig>, index: number): Promise<void> {
  await ctx.storage.write(CURSOR_FILE, new TextEncoder().encode(JSON.stringify({ index })))
}

async function readNextFeed(
  ctx: BrainContext<WebReaderConfig>,
  config: WebReaderConfig,
): Promise<ReadArticleResult | null> {
  const feeds = config.feeds ?? []
  if (feeds.length === 0) return null
  const index = await readCursor(ctx)
  const targetUrl = feeds[index % feeds.length]!
  const result = await readOneArticle(ctx, targetUrl, config)
  await writeCursor(ctx, index + 1)
  return result
}

export const apply: PluginApply<WebReaderConfig> = (ctx, config) => {
  ctx.scheduler.ownTime({
    name: 'read-feed',
    everyMs: config.everyMs ?? DEFAULT_EVERY_MS,
    run: async () => {
      await readNextFeed(ctx, config)
    },
  })

  ctx.http.route('POST', '/read', async (req) => {
    const body = req.body
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      throw new BrainError('INVALID_ARGUMENT', 'request body must be an object')
    }
    if (body !== null && body !== undefined && 'url' in body && body.url !== undefined) {
      if (typeof body.url !== 'string' || body.url.trim() === '') {
        throw new BrainError('INVALID_ARGUMENT', 'url must be a non-empty string')
      }
      return readOneArticle(ctx, body.url, config)
    }
    const result = await readNextFeed(ctx, config)
    if (result === null) {
      throw new BrainError('INVALID_ARGUMENT', 'no feeds configured')
    }
    return result
  })
}
