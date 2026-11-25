type SyncSignal = () => void

/** 推理结束等时机发出的轻量信号，由同步引擎订阅；避免 chat 与 sync 相互 import */
const listeners = new Set<SyncSignal>()

export const requestSync = () => {
  for (const listener of listeners) {
    listener()
  }
}

export const onSyncRequest = (listener: SyncSignal) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
