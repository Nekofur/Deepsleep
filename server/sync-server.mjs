#!/usr/bin/env node
/**
 * Deepsleep 同步服务器（零依赖，Node.js 18+）。
 *
 * 多用户：用「工具服务」的 DeepSeek API Key 作为身份。服务器拿 Key 向
 * DeepSeek 的 /models 校验一次（结果缓存 10 分钟），通过后按 Key 的
 * SHA-256 建立独立目录，用户之间互相看不到数据；原始 Key 不落盘。
 *
 * 每个用户目录：
 *   <data>/users/<sha256(key)>/state.json.gz   会话、删除记录与远端附件清单
 *   <data>/users/<sha256(key)>/files/<id>      图片原件
 *   <data>/users/<sha256(key)>/meta.json       递增版本号，用作 ETag
 *
 * 环境变量：
 *   PORT=8080                    监听端口
 *   SYNC_DATA_DIR=./.sync-data   数据目录
 *   SYNC_MAX_USERS=20            用户数上限；0 表示不限制
 *   SYNC_ADMIN_TOKEN             可选；设置后可用 X-Admin-Token 列出/删除用户
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

const PORT = Number(process.env.PORT ?? 8080)
const DATA_DIR = resolve(process.env.SYNC_DATA_DIR ?? '.sync-data')
const ADMIN_TOKEN = process.env.SYNC_ADMIN_TOKEN ?? ''
const USERS_DIR = join(DATA_DIR, 'users')
const STATE_LIMIT = 16 * 1024 * 1024
const FILE_LIMIT = 128 * 1024 * 1024
const MAX_USERS = Number(process.env.SYNC_MAX_USERS ?? 20)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, If-Match, If-None-Match, X-Admin-Token',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '600',
}

const json = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...cors,
    ...headers,
  })
  res.end(payload)
}

const digest = (value) => createHash('sha256').update(String(value)).digest()

const readBody = async (req, limit) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      throw Object.assign(new Error('request body too large'), { status: 413 })
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const safeFileId = (id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)

const userDir = (id) => join(USERS_DIR, id)
const statePath = (id) => join(userDir(id), 'state.json.gz')
const filesDir = (id) => join(userDir(id), 'files')
const metaPath = (id) => join(userDir(id), 'meta.json')

const readMeta = async (id) => {
  try {
    const value = JSON.parse(await readFile(metaPath(id), 'utf8'))
    return typeof value?.revision === 'number' ? value : null
  } catch {
    return null
  }
}

const parseEtagRevision = (value) => {
  const match = /^"?(\d+)"?$/.exec(String(value ?? '').trim())
  return match ? Number(match[1]) : null
}

/** 同一个用户的状态写入串行化，避免两个设备同时请求时互相覆盖 */
const locks = new Map()
const withUserLock = async (id, task) => {
  const previous = locks.get(id) ?? Promise.resolve()
  let release
  const current = new Promise((resolveLock) => {
    release = resolveLock
  })
  const tail = previous.then(() => current)
  locks.set(id, tail)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (locks.get(id) === tail) {
      locks.delete(id)
    }
  }
}

const userExists = async (id) => {
  try {
    await stat(userDir(id))
    return true
  } catch {
    return false
  }
}

/**
 * 凭据是前端校验通过后发来的 SHA-256（64 位十六进制）。服务器只认这个哈希，
 * 不接触原始 Key；首次出现时按 SYNC_MAX_USERS 限制用户数，之后直接复用目录。
 */
const requireUser = async (req, res) => {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim().toLowerCase() : ''
  if (!/^[a-f0-9]{64}$/.test(token)) {
    json(res, 401, { error: 'invalid sync token' }, { 'WWW-Authenticate': 'Bearer' })
    return null
  }
  if (!(await userExists(token))) {
    if (MAX_USERS > 0) {
      const users = await readdir(USERS_DIR)
      if (users.length >= MAX_USERS) {
        json(res, 403, { error: `user limit reached (${MAX_USERS})` })
        return null
      }
    }
    await mkdir(filesDir(token), { recursive: true })
  }
  return token
}
const adminAuthorized = (req) => {
  if (!ADMIN_TOKEN) {
    return false
  }
  const token = req.headers['x-admin-token']
  return typeof token === 'string' && timingSafeEqual(digest(token), digest(ADMIN_TOKEN))
}

const dirSize = async (path) => {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(child)
    } else if (entry.isFile()) {
      total += (await stat(child)).size
    }
  }
  return total
}

const handleStateGet = async (res, id) => {
  const meta = await readMeta(id)
  if (!meta) {
    json(res, 404, { error: 'no sync data yet' })
    return
  }
  try {
    const info = await stat(statePath(id))
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': info.size,
      ETag: `"${meta.revision}"`,
      'Cache-Control': 'no-store',
      ...cors,
    })
    createReadStream(statePath(id)).pipe(res)
  } catch {
    json(res, 404, { error: 'no sync data yet' })
  }
}

const handleStatePut = async (req, res, id) =>
  withUserLock(id, async () => {
    const meta = await readMeta(id)
    const current = meta?.revision ?? 0
    const ifMatch = req.headers['if-match']
    const ifNoneMatch = req.headers['if-none-match']
    if (ifNoneMatch === '*') {
      if (meta) {
        json(res, 412, { error: 'sync revision changed, pull again', revision: current })
        return
      }
    } else if (ifMatch !== undefined) {
      if (!meta || parseEtagRevision(ifMatch) !== current) {
        json(res, 412, { error: 'sync revision changed, pull again', revision: current })
        return
      }
    } else {
      json(res, 428, { error: 'If-Match or If-None-Match is required' })
      return
    }

    const body = await readBody(req, STATE_LIMIT)
    const temp = join(userDir(id), `state.${process.pid}.${Date.now()}.tmp`)
    try {
      await writeFile(temp, body)
      await rename(temp, statePath(id))
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
    const next = {
      revision: current + 1,
      updatedAt: new Date().toISOString(),
      size: body.length,
    }
    await writeFile(metaPath(id), JSON.stringify(next))
    json(res, 200, next, { ETag: `"${next.revision}"` })
  })

const handleFileGet = async (res, id, fileId) => {
  if (!safeFileId(fileId)) {
    json(res, 400, { error: 'invalid file id' })
    return
  }
  const path = join(filesDir(id), fileId)
  try {
    const info = await stat(path)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
      ...cors,
    })
    createReadStream(path).pipe(res)
  } catch {
    json(res, 404, { error: 'file not found' })
  }
}

const handleFilePut = async (req, res, id, fileId) => {
  if (!safeFileId(fileId)) {
    json(res, 400, { error: 'invalid file id' })
    return
  }
  const blob = await readBody(req, FILE_LIMIT)
  await mkdir(filesDir(id), { recursive: true })
  const temp = join(filesDir(id), `${fileId}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temp, blob)
    await rename(temp, join(filesDir(id), fileId))
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  json(res, 200, { ok: true, size: blob.length })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }
    if (url.pathname === '/api/health') {
      json(res, 200, { ok: true, name: 'deepsleep-sync', version: 4, maxUsers: MAX_USERS })
      return
    }

    // 管理接口：需要单独的 X-Admin-Token，未设置时整组不可用
    if (url.pathname.startsWith('/api/admin/')) {
      if (!adminAuthorized(req)) {
        json(res, 404, { error: 'not found' })
        return
      }
      if (url.pathname === '/api/admin/users' && req.method === 'GET') {
        await mkdir(USERS_DIR, { recursive: true })
        const users = []
        for (const entry of await readdir(USERS_DIR, { withFileTypes: true })) {
          if (!entry.isDirectory()) {
            continue
          }
          const meta = await readMeta(entry.name)
          users.push({
            id: entry.name,
            revision: meta?.revision ?? 0,
            updatedAt: meta?.updatedAt ?? null,
            bytes: await dirSize(join(USERS_DIR, entry.name)),
          })
        }
        json(res, 200, { users })
        return
      }
      const adminUser = /^\/api\/admin\/users\/([a-f0-9]{64})$/.exec(url.pathname)
      if (adminUser && req.method === 'DELETE') {
        await rm(userDir(adminUser[1]), { recursive: true, force: true })
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { error: 'not found' })
      return
    }

    const id = await requireUser(req, res)
    if (!id) {
      return
    }

    if (url.pathname === '/api/sync/me' && req.method === 'GET') {
      const meta = await readMeta(id)
      json(res, 200, {
        user: id.slice(0, 12),
        revision: meta?.revision ?? 0,
        updatedAt: meta?.updatedAt ?? null,
      })
      return
    }
    if (url.pathname === '/api/sync/state' && req.method === 'GET') {
      await handleStateGet(res, id)
      return
    }
    if (url.pathname === '/api/sync/state' && req.method === 'PUT') {
      await handleStatePut(req, res, id)
      return
    }
    const fileMatch = /^\/api\/sync\/files\/([^/]+)$/.exec(url.pathname)
    if (fileMatch && req.method === 'GET') {
      await handleFileGet(res, id, decodeURIComponent(fileMatch[1]))
      return
    }
    if (fileMatch && req.method === 'PUT') {
      await handleFilePut(req, res, id, decodeURIComponent(fileMatch[1]))
      return
    }
    json(res, 404, { error: 'not found' })
  } catch (error) {
    const status = error?.status ?? 500
    if (status >= 500) {
      console.error('[sync] request failed', error)
    }
    if (!res.headersSent) {
      json(res, status, { error: error instanceof Error ? error.message : 'server error' })
    } else {
      res.end()
    }
  }
})

await mkdir(USERS_DIR, { recursive: true })
server.listen(PORT, () => {
  console.log(`[sync] listening on http://localhost:${PORT}`)
  console.log(`[sync] data dir: ${DATA_DIR}`)
  console.log(`[sync] max users: ${MAX_USERS > 0 ? MAX_USERS : 'unlimited'}`)
  if (!ADMIN_TOKEN) {
    console.log('[sync] SYNC_ADMIN_TOKEN 未设置，管理接口已关闭')
  }
})
