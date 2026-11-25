import { toSessionSummary, type Session, type SessionSummary } from '../chat/types.js'

/** 90 天前的删除记录且两端都已不存在时清理，避免清单无限增长 */
const TOMBSTONE_TTL = 90 * 24 * 60 * 60 * 1000

/** 本地参与合并的集合：已下载的正文、列表里的全部摘要、本机删除记录 */
export type LocalIndex = {
  /** 本地有正文的会话（collectSessions 的结果） */
  sessions: Session[]
  /** 界面列表里的摘要，含远端未下载的占位项 */
  summaries: SessionSummary[]
  tombstones: Record<string, number>
}

/** 远端清单中参与合并的部分 */
export type RemoteIndex = {
  sessions: SessionSummary[]
  tombstones: Record<string, number>
  files: string[]
}

export type SyncMerge = {
  /** 合并后的会话摘要（含未下载的远端会话），按 updatedAt 降序 */
  sessions: SessionSummary[]
  /** 远端更新、本地已有正文，需要下载后覆盖本地 */
  incoming: string[]
  /** 需要从本地删除的会话 id */
  removed: string[]
  /** 远端独有、本地还没有正文的会话 id */
  remoteOnly: string[]
  /** 本地更新或远端缺失，需要上传正文的会话 id */
  outgoing: string[]
  /** 合并后的删除记录 */
  tombstones: Record<string, number>
  /** 合并后的远端图片清单 */
  files: string[]
}

const summaryOf = (session: Session | SessionSummary): SessionSummary => toSessionSummary(session)

/**
 * 会话级合并：摘要按 updatedAt 取较新的一份，删除记录优先于更早的版本。
 * 时间相同时保留本地版本，避免两端反复互写。
 *
 * 本地只有摘要、没有正文的会话是上次同步留下的占位项：远端还有就继续标为未下载，
 * 远端没有就丢弃；本地有正文而远端更新时，下载正文后覆盖本地。
 */
export const mergeSync = (local: LocalIndex, remote: RemoteIndex): SyncMerge => {
  const tombstones: Record<string, number> = { ...local.tombstones }
  for (const [id, at] of Object.entries(remote.tombstones)) {
    tombstones[id] = Math.max(tombstones[id] ?? 0, at)
  }

  const localById = new Map(local.sessions.map((session) => [session.id, session]))
  const listedById = new Map(local.summaries.map((summary) => [summary.id, summary]))
  const remoteById = new Map(remote.sessions.map((summary) => [summary.id, summary]))
  const ids = new Set([...localById.keys(), ...listedById.keys(), ...remoteById.keys()])

  const sessions: SessionSummary[] = []
  const incoming: string[] = []
  const removed: string[] = []
  const remoteOnly: string[] = []
  const outgoing: string[] = []
  /** 删除后又被新版本覆盖的会话，合并结束后从删除记录里移除 */
  const superseded = new Set<string>()

  for (const id of ids) {
    const downloaded = localById.get(id)
    const localSummary = downloaded ? summaryOf(downloaded) : listedById.get(id)
    const remoteSummary = remoteById.get(id)
    const newest = Math.max(
      localSummary?.updatedAt ?? Number.NEGATIVE_INFINITY,
      remoteSummary?.updatedAt ?? Number.NEGATIVE_INFINITY
    )
    const deletedAt = tombstones[id]
    if (deletedAt !== undefined && newest <= deletedAt) {
      // 已删除：本地有就删掉，也不进入上传
      if (localSummary) {
        removed.push(id)
      }
      continue
    }
    // 删除后又有新版本（例如另一台设备重新生成），删除记录失效
    if (deletedAt !== undefined) {
      superseded.add(id)
    }
    if (!remoteSummary) {
      // 远端没有：本地有正文才保留并上传；只剩占位项时直接丢弃
      if (localSummary && downloaded) {
        sessions.push(localSummary)
        outgoing.push(id)
      }
      continue
    }
    if (!downloaded) {
      // 本地没有正文：显示为未下载，打开时再拉取
      sessions.push(remoteSummary)
      remoteOnly.push(id)
      continue
    }
    if (remoteSummary.updatedAt > downloaded.updatedAt) {
      sessions.push(remoteSummary)
      incoming.push(id)
      continue
    }
    sessions.push(summaryOf(downloaded))
    if (remoteSummary.updatedAt < downloaded.updatedAt) {
      outgoing.push(id)
    }
  }

  // 清理失效与过期的删除记录，避免清单无限增长
  const now = Date.now()
  const currentTombstones: Record<string, number> = {}
  for (const [id, at] of Object.entries(tombstones)) {
    if (superseded.has(id) || (!ids.has(id) && now - at > TOMBSTONE_TTL)) {
      continue
    }
    currentTombstones[id] = at
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return {
    sessions,
    incoming,
    removed,
    remoteOnly,
    outgoing,
    tombstones: currentTombstones,
    files: [...new Set(remote.files)],
  }
}

const sameSummaries = (left: SessionSummary[], right: SessionSummary[]): boolean => {
  if (left.length !== right.length) {
    return false
  }
  const rightById = new Map(right.map((summary) => [summary.id, summary]))
  return left.every((summary) => {
    const other = rightById.get(summary.id)
    return other !== undefined && other.updatedAt === summary.updatedAt
  })
}

/** 写回远端前判断清单是否有变化：会话列表、删除记录与图片清单 */
export const manifestChanged = (
  next: { sessions: SessionSummary[]; tombstones: Record<string, number>; files: string[] },
  remote: { sessions: SessionSummary[]; tombstones: Record<string, number>; files: string[] } | null
): boolean => {
  if (!remote) {
    return (
      next.sessions.length > 0 || next.files.length > 0 || Object.keys(next.tombstones).length > 0
    )
  }
  if (!sameSummaries(next.sessions, remote.sessions) || next.files.length !== remote.files.length) {
    return true
  }
  const remoteFiles = new Set(remote.files)
  if (next.files.some((id) => !remoteFiles.has(id))) {
    return true
  }
  const localIds = Object.keys(next.tombstones)
  const remoteIds = Object.keys(remote.tombstones)
  return (
    localIds.length !== remoteIds.length ||
    localIds.some((id) => remote.tombstones[id] !== next.tombstones[id])
  )
}
