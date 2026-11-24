import type { Session } from '../chat/types.js'

/** 90 天前的删除记录且两端都已不存在时清理，避免同步状态无限增长 */
const TOMBSTONE_TTL = 90 * 24 * 60 * 60 * 1000

/** 参与合并的最小集合：状态文件去掉附件清单后的部分 */
export type MergeInput = {
  sessions: Session[]
  tombstones: Record<string, number>
}

export type MergeResult = {
  /** 合并后的全部会话，用于上传与本地落库 */
  sessions: Session[]
  /** 需要写入本地的远程会话：本地没有，或远程版本更新 */
  incoming: Session[]
  /** 需要从本地删除的会话 id */
  removed: string[]
  tombstones: Record<string, number>
  /** 本地是否需要写入或删除 */
  changed: boolean
}

/**
 * 会话级合并：同一 id 取 updatedAt 较新的一份，删除记录优先于更早的版本。
 * 时间相同时保留本地版本，避免两端反复互写。
 */
export const mergeArchives = (local: MergeInput, remote: MergeInput): MergeResult => {
  const tombstones: Record<string, number> = { ...local.tombstones }
  for (const [id, at] of Object.entries(remote.tombstones)) {
    tombstones[id] = Math.max(tombstones[id] ?? 0, at)
  }

  const localById = new Map(local.sessions.map((session) => [session.id, session]))
  const remoteById = new Map(remote.sessions.map((session) => [session.id, session]))
  const ids = new Set([...localById.keys(), ...remoteById.keys()])

  const sessions: Session[] = []
  const incoming: Session[] = []
  const removed: string[] = []
  /** 删除后又被新版本覆盖的会话，合并结束后从删除记录里移除 */
  const superseded = new Set<string>()

  for (const id of ids) {
    const localSession = localById.get(id)
    const remoteSession = remoteById.get(id)
    const newest =
      !localSession || (remoteSession && remoteSession.updatedAt > localSession.updatedAt)
        ? remoteSession
        : localSession
    const deletedAt = tombstones[id]
    if (deletedAt !== undefined && (!newest || newest.updatedAt <= deletedAt)) {
      // 已删除：本地有就删掉，也不进入上传
      if (localSession) {
        removed.push(id)
      }
      continue
    }
    // 删除后又有新版本（例如另一台设备重新生成），删除记录失效
    if (deletedAt !== undefined) {
      superseded.add(id)
    }
    if (!newest) {
      continue
    }
    sessions.push(newest)
    if (remoteSession === newest && localSession !== newest) {
      incoming.push(newest)
    }
  }

  // 清理失效与过期的删除记录，避免同步状态无限增长
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
    tombstones: currentTombstones,
    changed: incoming.length > 0 || removed.length > 0,
  }
}

/** 合并结果是否需要写回远端：远端缺少会话，或版本/删除记录不同 */
export const stateChanged = (
  merged: Session[],
  tombstones: Record<string, number>,
  files: string[],
  remote: (MergeInput & { files: string[] }) | null
): boolean => {
  if (!remote) {
    return merged.length > 0 || files.length > 0
  }
  if (remote.sessions.length !== merged.length || remote.files.length !== files.length) {
    return true
  }
  const remoteById = new Map(remote.sessions.map((session) => [session.id, session]))
  if (merged.some((session) => remoteById.get(session.id)?.updatedAt !== session.updatedAt)) {
    return true
  }
  const remoteFiles = new Set(remote.files)
  if (files.some((id) => !remoteFiles.has(id))) {
    return true
  }
  const remoteTombstones = remote.tombstones
  const localIds = Object.keys(tombstones)
  return (
    localIds.length !== Object.keys(remoteTombstones).length ||
    localIds.some((id) => remoteTombstones[id] !== tombstones[id])
  )
}
