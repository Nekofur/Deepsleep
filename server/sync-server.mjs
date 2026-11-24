#!/usr/bin/env node
/**
 * chat-demo 同步服务器（零依赖，Node.js 18+）。
 *
 * 只有一个密码：客户端把密码作为 Authorization: Bearer 发送。
 * 存储为「状态文件 + 附件原件」：
 *   <data>/state.json.gz          会话、删除记录与远端附件清单（gzip）
 *   <data>/files/<attachment_id>  图片原件，按需上传
 *   <data>/meta.json              递增版本号，用作状态文件的 ETag
 * 状态文件用 If-Match / If-None-Match 做条件写入，冲突返回 412，
 * 客户端重新拉取合并后再写，因此不会静默覆盖其他设备的会话。
 *
 * 环境变量：
 *   PORT=8080            监听端口
 *   SYNC_PASSWORD        访问密码（必须修改默认值）
 *   SYNC_DATA_DIR=./.sync-data 数据目录
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

const PORT = Number(process.env.PORT ?? 8080)
const DATA_DIR = resolve(process.env.SYNC_DATA_DIR ?? '.sync-data')
const PASSWORD = process.env.SYNC_PASSWORD ?? 'demo'
const STATE_LIMIT = 16 * 1024 * 1024
const FILE_LIMIT = 128 * 1024 * 1024
const FILES_DIR = join(DATA_DIR, 'files')
const STATE_PATH = join(DATA_DIR, 'state.json.gz')
const META_PATH = join(DATA_DIR, 'meta.json')

if (!process.env.SYNC_PASSWORD) {
  console.warn('[sync] SYNC_PASSWORD 未设置，使用演示密码 demo；请在生产环境中替换。')
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match',
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
const PASSWORD_DIGEST = digest(PASSWORD)

const authorized = (req) => {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  return token.length > 0 && timingSafeEqual(digest(token), PASSWORD_DIGEST)
}

const readMeta = async () => {
  try {
    const value = JSON.parse(await readFile(META_PATH, 'utf8'))
    return typeof value?.revision === 'number' ? value : null
  } catch {
    return null
  }
}

const parseEtagRevision = (value) => {
  const match = /^"?(\d+)"?$/.exec(String(value ?? '').trim())
  return match ? Number(match[1]) : null
}

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

const handleStateGet = async (res) => {
  const meta = await readMeta()
  if (!meta) {
    json(res, 404, { error: 'no sync data yet' })
    return
  }
  try {
    const info = await stat(STATE_PATH)
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': info.size,
      ETag: `"${meta.revision}"`,
      'Cache-Control': 'no-store',
      ...cors,
    })
    createReadStream(STATE_PATH).pipe(res)
  } catch {
    json(res, 404, { error: 'no sync data yet' })
  }
}

const handleStatePut = async (req, res) => {
  const meta = await readMeta()
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
  const temp = join(DATA_DIR, `state.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temp, body)
    await rename(temp, STATE_PATH)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  const next = { revision: current + 1, updatedAt: new Date().toISOString(), size: body.length }
  await writeFile(META_PATH, JSON.stringify(next))
  json(res, 200, next, { ETag: `"${next.revision}"` })
}

const handleFileGet = async (res, id) => {
  if (!safeFileId(id)) {
    json(res, 400, { error: 'invalid file id' })
    return
  }
  const path = join(FILES_DIR, id)
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

const handleFilePut = async (req, res, id) => {
  if (!safeFileId(id)) {
    json(res, 400, { error: 'invalid file id' })
    return
  }
  await mkdir(FILES_DIR, { recursive: true })
  const blob = await readBody(req, FILE_LIMIT)
  const temp = join(FILES_DIR, `${id}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temp, blob)
    await rename(temp, join(FILES_DIR, id))
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
      json(res, 200, { ok: true, name: 'chat-demo-sync', version: 2 })
      return
    }
    if (!authorized(req)) {
      json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
      return
    }
    if (url.pathname === '/api/sync/state' && req.method === 'GET') {
      await handleStateGet(res)
      return
    }
    if (url.pathname === '/api/sync/state' && req.method === 'PUT') {
      await handleStatePut(req, res)
      return
    }
    const fileMatch = /^\/api\/sync\/files\/([^/]+)$/.exec(url.pathname)
    if (fileMatch && req.method === 'GET') {
      await handleFileGet(res, decodeURIComponent(fileMatch[1]))
      return
    }
    if (fileMatch && req.method === 'PUT') {
      await handleFilePut(req, res, decodeURIComponent(fileMatch[1]))
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

await mkdir(DATA_DIR, { recursive: true })
await mkdir(FILES_DIR, { recursive: true })
server.listen(PORT, () => {
  console.log(`[sync] listening on http://localhost:${PORT}`)
  console.log(`[sync] data dir: ${DATA_DIR}`)
})
