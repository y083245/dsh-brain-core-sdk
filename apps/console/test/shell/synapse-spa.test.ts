import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validate } from '@dsh-brain-core/sdk'
import { makeBrainHome, startConsole, TOKEN } from './helpers.ts'

const WEB_SRC_DIR = fileURLToPath(new URL('../../web/src', import.meta.url))

function rawGet(
  port: number,
  rawPath: string,
  token: string | null = TOKEN,
): Promise<{
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly text: string
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: rawPath,
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function collectSourceFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(full)))
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(full)
    }
  }
  return files.sort()
}

test('GET / serves built SYNAPSE SPA HTML with security headers and loads referenced /synapse/assets/*.js and *.css', async () => {
  const home = await makeBrainHome()
  const consoleServer = await startConsole(home)
  try {
    const res = await fetch(`http://127.0.0.1:${String(consoleServer.port)}/`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('x-frame-options'), 'DENY')

    const html = await res.text()
    assert.match(html, /<html lang="zh-CN" data-theme="dark">/)
    assert.match(html, /id="token-login-form"/)
    assert.match(html, /type="password"/)
    assert.equal(html.includes('role-card-active'), false)
    assert.equal(html.includes('shared-quota-warning'), false)
    assert.equal(html.includes('settings-panel'), false)
    assert.equal(html.includes('data-agent-class'), false)

    const jsMatches = [...html.matchAll(/(?:src|href)="(\/synapse\/assets\/[^"]+\.js)"/g)].map((m) => m[1]!)
    const cssMatches = [...html.matchAll(/href="(\/synapse\/assets\/[^"]+\.css)"/g)].map((m) => m[1]!)
    assert.ok(jsMatches.length >= 1, 'expected at least one /synapse/assets/*.js bundle in index.html')
    assert.ok(cssMatches.length >= 1, 'expected at least one /synapse/assets/*.css bundle in index.html')

    for (const jsPath of jsMatches) {
      const jsRes = await fetch(`http://127.0.0.1:${String(consoleServer.port)}${jsPath}`)
      assert.equal(jsRes.status, 200, jsPath)
      assert.equal(jsRes.headers.get('content-type'), 'application/javascript; charset=utf-8', jsPath)
      assert.equal(jsRes.headers.get('x-content-type-options'), 'nosniff', jsPath)
      assert.equal(jsRes.headers.get('cache-control'), 'public, max-age=31536000, immutable', jsPath)
      const jsText = await jsRes.text()
      assert.ok(jsText.length > 0, `${jsPath} must not be empty`)

      const headRes = await fetch(`http://127.0.0.1:${String(consoleServer.port)}${jsPath}`, { method: 'HEAD' })
      assert.equal(headRes.status, 200, `HEAD ${jsPath}`)
      assert.equal(headRes.headers.get('content-type'), 'application/javascript; charset=utf-8', `HEAD ${jsPath}`)
      assert.equal(headRes.headers.get('x-content-type-options'), 'nosniff', `HEAD ${jsPath}`)
    }

    for (const cssPath of cssMatches) {
      const cssRes = await fetch(`http://127.0.0.1:${String(consoleServer.port)}${cssPath}`)
      assert.equal(cssRes.status, 200, cssPath)
      assert.equal(cssRes.headers.get('content-type'), 'text/css; charset=utf-8', cssPath)
      assert.equal(cssRes.headers.get('x-content-type-options'), 'nosniff', cssPath)
      assert.equal(cssRes.headers.get('cache-control'), 'public, max-age=31536000, immutable', cssPath)
      const cssText = await cssRes.text()
      assert.ok(cssText.length > 0, `${cssPath} must not be empty`)
    }

    // Non-assets file under /synapse/* uses Cache-Control: no-store
    const rootHtmlRes = await fetch(`http://127.0.0.1:${String(consoleServer.port)}/synapse/index.html`)
    assert.equal(rootHtmlRes.status, 200)
    assert.equal(rootHtmlRes.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(rootHtmlRes.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(rootHtmlRes.headers.get('cache-control'), 'no-store')
  } finally {
    await consoleServer.close()
    await home.close()
  }
})

test('path traversal, null-byte, directory read, and symlink escape attacks against /synapse/* all return 404 NOT_FOUND', async () => {
  const home = await makeBrainHome()
  const customDistDir = path.join(home.dir, 'custom-dist-web')
  const customAssetsDir = path.join(customDistDir, 'assets')
  await mkdir(customAssetsDir, { recursive: true })
  await writeFile(
    path.join(customDistDir, 'index.html'),
    '<!doctype html><html lang="zh-CN" data-theme="dark"><body><form id="token-login-form"><input type="password"></form></body></html>',
    'utf8',
  )
  await writeFile(path.join(customAssetsDir, 'app.js'), 'console.log("ok")\n', 'utf8')

  const outsideSecretSentinel = 'OUTSIDE-SECRET-SENTINEL-DO-NOT-LEAK-8821'
  const outsideFile = path.join(home.dir, 'secrets.json')
  await writeFile(outsideFile, JSON.stringify({ secret: outsideSecretSentinel }), 'utf8')

  let symlinkCreated = false
  try {
    await symlink(outsideFile, path.join(customDistDir, 'escape-link.json'))
    symlinkCreated = true
  } catch {
    // On Windows without Developer Mode, symlink creation may throw EPERM.
  }

  const consoleServer = await startConsole(home, { webDistDir: customDistDir })
  try {
    const attackPaths: string[] = [
      '/synapse/../package.json',
      '/synapse/%2e%2e/package.json',
      '/synapse/..%2fsecrets.json',
      '/synapse/%2e%2e%5csecrets.json',
      '/synapse/assets/../../package.json',
      '/synapse/%00index.html',
      '/synapse/assets/',
      '/synapse/',
      '/synapse',
      '/synapse//assets/app.js',
      '/synapse/assets\\app.js',
    ]
    if (symlinkCreated) {
      attackPaths.push('/synapse/escape-link.json')
    }

    for (const attackPath of attackPaths) {
      for (const token of [null, TOKEN]) {
        const res = await rawGet(consoleServer.port, attackPath, token)
        assert.equal(res.status, 404, `expected 404 for ${attackPath} (token=${String(token)})`)
        assert.equal(res.text.includes(outsideSecretSentinel), false, `must not leak sentinel on ${attackPath}`)
        assert.equal(res.text.includes('@dsh-brain-core/console'), false, `must not leak package.json on ${attackPath}`)
        const parsed = JSON.parse(res.text) as Record<string, unknown>
        validate('Envelope', parsed)
        assert.equal(parsed.ok, false)
        assert.equal((parsed.error as { code?: string }).code, 'NOT_FOUND')
      }
    }
  } finally {
    await consoleServer.close()
    await home.close()
  }
})

test('webDistDir pointing to a nonexistent directory safely falls back to the bare login shell without business data', async () => {
  const home = await makeBrainHome()
  const consoleServer = await startConsole(home, {
    webDistDir: path.join(home.dir, 'does-not-exist-dist-web'),
  })
  try {
    await consoleServer.request('PUT', '/api/v1/console/settings/model', {
      body: { agentClass: 'chat', provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' },
    })
    await consoleServer.request('PUT', '/api/v1/console/settings/secret', {
      body: { name: 'deepseek-api-key', value: 'sk-fallback-secret-999' },
    })
    await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'raw', name: '小满', text: '# 小满\n' },
    })

    for (const token of [null, TOKEN]) {
      const res = await fetch(`http://127.0.0.1:${String(consoleServer.port)}/?theme=light`, {
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(res.headers.get('x-frame-options'), 'DENY')
      assert.equal(res.headers.get('cache-control'), 'no-store')

      const html = await res.text()
      assert.match(html, /data-theme="light"/)
      assert.match(html, /id="token-login-form"/)
      assert.match(html, /type="password"/)
      assert.equal(html.includes('小满'), false)
      assert.equal(html.includes('deepseek-flash'), false)
      assert.equal(html.includes('sk-fallback-secret-999'), false)
      assert.equal(html.includes('settings-panel'), false)
      assert.equal(html.includes('role-card-active'), false)
      assert.equal(html.includes('shared-quota-warning'), false)
    }
  } finally {
    await consoleServer.close()
    await home.close()
  }
})

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('frontend source audit: 0 dangerouslySetInnerHTML, 0 sessionStorage/cookie, and localStorage restricted to brain-console-theme', async () => {
  const files = await collectSourceFiles(WEB_SRC_DIR)
  assert.ok(files.length > 0, 'expected frontend source files under apps/console/web/src')

  for (const file of files) {
    const rel = path.relative(WEB_SRC_DIR, file)
    const rawSource = await readFile(file, 'utf8')
    const source = stripComments(rawSource)

    assert.equal(
      rawSource.includes('dangerouslySetInnerHTML'),
      false,
      `${rel} must not use dangerouslySetInnerHTML`,
    )
    assert.equal(
      /\bsessionStorage\b/.test(source),
      false,
      `${rel} must not touch sessionStorage`,
    )
    assert.equal(
      /\bdocument\.cookie\b/.test(source),
      false,
      `${rel} must not touch document.cookie`,
    )

    if (/\blocalStorage\b/.test(source)) {
      assert.ok(
        source.includes('brain-console-theme'),
        `${rel} uses localStorage without referencing brain-console-theme`,
      )
      assert.equal(
        /localStorage\.setItem\s*\([^)]*(?:token|secret)/i.test(source),
        false,
        `${rel} must never store tokens or secrets in localStorage`,
      )
    }
  }
})
