import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { setOriginalVolume } from '@/lib/api'

/** 主播放器（video 元素）当前状态；返回 null 表示暂无可跟随的画面 */
export interface MasterState {
  /** 成片时间轴上的绝对秒数 */
  time: number
  playing: boolean
  rate: number
  /** 主音量（已考虑静音），0–1 */
  volume: number
}

const SYNC_INTERVAL_MS = 200
const HARD_SEEK_DRIFT = 0.25 // 超过则直接跳转
const SOFT_DRIFT = 0.03 // 超过则微调播放速度追赶
const MAX_RATE_NUDGE = 0.05

/**
 * 原声轨跟随画面播放：成片视频只含配音，原声由隐藏的 <audio> 播放，
 * 音量 = 主音量 × 原声音量，可实时调节。通过微调 playbackRate 把偏差压在几十毫秒内。
 */
export function useOriginalTrack(
  src: string | null,
  getMaster: () => MasterState | null,
  originalVolume: number,
): void {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const getMasterRef = useRef(getMaster)
  const volumeRef = useRef(originalVolume)
  useEffect(() => { getMasterRef.current = getMaster }, [getMaster])

  useEffect(() => {
    if (!src) return
    const el = new Audio()
    el.preload = 'auto'
    el.src = src
    audioRef.current = el
    const timer = window.setInterval(() => {
      const master = getMasterRef.current()
      if (!master || !master.playing || el.readyState < 1) {
        if (!el.paused) el.pause()
        return
      }
      el.volume = Math.max(0, Math.min(1, master.volume * volumeRef.current))
      const target = master.time
      if (Number.isFinite(el.duration) && target >= el.duration) {
        if (!el.paused) el.pause()
        return
      }
      if (el.paused) {
        try { el.currentTime = target } catch { /* 尚不可跳转 */ }
        el.playbackRate = master.rate
        el.play().catch(() => { /* 需要用户手势时由下一次轮询重试 */ })
        return
      }
      const drift = el.currentTime - target
      if (Math.abs(drift) > HARD_SEEK_DRIFT) {
        el.currentTime = target
        el.playbackRate = master.rate
      } else if (Math.abs(drift) > SOFT_DRIFT) {
        const nudge = Math.max(-MAX_RATE_NUDGE, Math.min(MAX_RATE_NUDGE, drift * 0.5))
        el.playbackRate = master.rate * (1 - nudge)
      } else {
        el.playbackRate = master.rate
      }
    }, SYNC_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      el.pause()
      el.removeAttribute('src')
      el.load()
      audioRef.current = null
    }
  }, [src])

  // 拖动原声滑块时立即生效，不等下一次轮询。
  useEffect(() => {
    volumeRef.current = originalVolume
    const el = audioRef.current
    const master = getMasterRef.current()
    if (el && master) el.volume = Math.max(0, Math.min(1, master.volume * originalVolume))
  }, [originalVolume])
}

// 待保存的原声音量（按任务）。放在模块级：组件卸载、切换任务或点击下载时都能把它立即写到后端，
// 而不是随 600ms 防抖定时器一起被丢弃——导出/素材包都按后端保存的音量混音。
const pendingVolumes = new Map<string, { timer: ReturnType<typeof setTimeout>; value: number }>()
const inflightVolumes = new Map<string, Promise<void>>()

function sendVolume(taskId: string, value: number): Promise<void> {
  const p = setOriginalVolume(taskId, value)
    .catch((err) => { console.warn('[原声音量] 保存失败', err) })
    .finally(() => { if (inflightVolumes.get(taskId) === p) inflightVolumes.delete(taskId) })
  inflightVolumes.set(taskId, p)
  return p
}

/** 立即保存尚在防抖中的音量，并等待已发出的保存完成。 */
export function flushOriginalVolume(taskId: string): Promise<void> {
  const pending = pendingVolumes.get(taskId)
  if (pending) {
    clearTimeout(pending.timer)
    pendingVolumes.delete(taskId)
    return sendVolume(taskId, pending.value)
  }
  return inflightVolumes.get(taskId) ?? Promise.resolve()
}

export function flushAllOriginalVolumes(): Promise<void> {
  const ids = new Set([...pendingVolumes.keys(), ...inflightVolumes.keys()])
  return Promise.all([...ids].map(flushOriginalVolume)).then(() => undefined)
}

/**
 * 下载链接的 onClick：若有音量尚未落盘，先拦下这次点击，保存完成后再重新触发同一个链接，
 * 保证下载到的成片用的是滑块上的当前音量。taskId 省略时等待所有任务（如整包下载）。
 */
export function exportAfterVolumeSaved(taskId?: string) {
  return (e: ReactMouseEvent<HTMLAnchorElement>) => {
    const busy = taskId
      ? pendingVolumes.has(taskId) || inflightVolumes.has(taskId)
      : pendingVolumes.size > 0 || inflightVolumes.size > 0
    if (!busy) return
    e.preventDefault()
    const anchor = e.currentTarget
    void (taskId ? flushOriginalVolume(taskId) : flushAllOriginalVolumes()).then(() => anchor.click())
  }
}

/** 任务级原声音量：本地即时更新，停手 600ms 后保存到后端（导出按该值混音）。 */
export function useOriginalVolume(taskId: string, initial: number | undefined): [number, (v: number) => void] {
  const [volume, setVolume] = useState(initial ?? 0.2)
  const touched = useRef(false)

  // 任务切换或首次拿到状态时同步初值；用户调过之后不被轮询覆盖。
  // 卸载或切走任务时立即保存未落盘的值，而不是丢弃。
  useEffect(() => {
    touched.current = false
    return () => { void flushOriginalVolume(taskId) }
  }, [taskId])
  useEffect(() => {
    if (!touched.current && initial !== undefined) setVolume(initial)
  }, [initial, taskId])

  const change = useCallback((value: number) => {
    const v = Math.round(Math.max(0, Math.min(1, value)) * 100) / 100
    touched.current = true
    setVolume(v)
    const prev = pendingVolumes.get(taskId)
    if (prev) clearTimeout(prev.timer)
    const timer = setTimeout(() => {
      pendingVolumes.delete(taskId)
      void sendVolume(taskId, v)
    }, 600)
    pendingVolumes.set(taskId, { timer, value: v })
  }, [taskId])

  return [volume, change]
}
