import { useEffect, useState, useRef } from 'react'
import {
  Download, ChevronDown, Crown, Check,
  Play, Pause, Volume2, VolumeX, Captions, Maximize, Video, Type, AudioWaveform,
  Music, RotateCcw, Copy, Sparkles, Film, ZoomIn, ZoomOut
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { getSubtitles, getAudioUrl, getExportUrl, getVideoUrl, getTaskStatus, type SubtitleSegment, type TaskStatus } from '@/lib/api'

interface ResultStateProps {
  taskId: string
  onReset: () => void
}

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

function getExportFilename(originalFilename?: string, targetLang?: string): string {
  if (!originalFilename) return 'translated_中文翻译版.mp4'
  const lastDot = originalFilename.lastIndexOf('.')
  const baseName = lastDot > 0 ? originalFilename.substring(0, lastDot) : originalFilename
  const langLabels: Record<string, string> = {
    zh: '中文',
    'zh-cn': '中文',
    'zh-tw': '繁体中文',
    chinese: '中文',
    en: '英文',
    english: '英文',
    ja: '日语',
    japanese: '日语',
    ko: '韩语',
    korean: '韩语',
    fr: '法语',
    french: '法语',
    de: '德语',
    german: '德语',
    es: '西班牙语',
    spanish: '西班牙语',
    ru: '俄语',
    russian: '俄语',
  }
  const key = (targetLang || 'zh').toLowerCase().trim()
  const langLabel = langLabels[key] || '中文'
  return `${baseName}_${langLabel}翻译版.mp4`
}

export default function ResultState({ taskId, onReset }: ResultStateProps) {
  const [taskStatus, setTaskStatus] = useState<TaskStatus | null>(null)
  const [subtitles, setSubtitles] = useState<SubtitleSegment[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(15) // 默认回退为 15 秒
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [showSubtitles, setShowSubtitles] = useState(true)
  const [copiedId, setCopiedId] = useState(false)
  const [zoomScale, setZoomScale] = useState(1)

  const videoRef = useRef<HTMLVideoElement>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const timelineScrollRef = useRef<HTMLDivElement>(null)

  const [thumbnails, setThumbnails] = useState<string[]>([])
  const [isDraggingUI, setIsDraggingUI] = useState(false)
  const isDraggingRef = useRef(false)
  const pendingSeekRef = useRef<number | null>(null)
  const lastVideoUpdate = useRef(0)

  const ttsAudioUrl = getAudioUrl(taskId, 'tts')
  const videoUrl = getVideoUrl(taskId)
  const exportUrl = getExportUrl(taskId)

  // 获取任务状态与字幕
  useEffect(() => {
    getTaskStatus(taskId).then(setTaskStatus).catch(() => {})
    getSubtitles(taskId)
      .then((data) => {
        if (data && data.length > 0) {
          setSubtitles(data)
          const lastEnd = data[data.length - 1].end
          if (lastEnd > 0) setDuration(Math.max(10, Math.ceil(lastEnd)))
        }
      })
      .catch(() => {})
  }, [taskId])

  // 提取时间轴视频缩略图
  useEffect(() => {
    if (!videoUrl) return
    const extract = async () => {
      try {
        const video = document.createElement('video')
        video.src = videoUrl
        video.crossOrigin = 'anonymous'
        video.muted = true
        video.playsInline = true

        await new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve
          video.onerror = reject
        })

        const count = 30
        const interval = video.duration / count
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const r = video.videoWidth / video.videoHeight
        canvas.height = 60
        canvas.width = 60 * (r || 16/9)

        const thumbs: string[] = []
        for (let i = 0; i < count; i++) {
          video.currentTime = i * interval
          await new Promise(r => { video.onseeked = r })
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          thumbs.push(canvas.toDataURL('image/jpeg', 0.5))
        }
        setThumbnails(thumbs)
      } catch (e) {
        console.error('Failed to extract thumbs', e)
      }
    }
    extract()
  }, [videoUrl])

  // 通过 requestAnimationFrame 平滑同步视频时间
  useEffect(() => {
    let animationFrameId: number
    const updateTime = () => {
      if (videoRef.current && !videoRef.current.paused && !isDraggingRef.current) {
        setCurrentTime(videoRef.current.currentTime)
      }
      animationFrameId = requestAnimationFrame(updateTime)
    }
    updateTime()
    return () => cancelAnimationFrame(animationFrameId)
  }, [])

  // Ctrl+滚轮缩放
  useEffect(() => {
    const container = timelineScrollRef.current
    if (!container) return
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const delta = e.deltaY * -0.01
        setZoomScale(prev => Math.min(20, Math.max(1, prev + delta)))
      } else {
        // 常规滚轮原生横向平移
        if (e.deltaY !== 0 && e.deltaX === 0) {
          e.preventDefault()
          container.scrollLeft += e.deltaY
        }
      }
    }
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [])

  // 同步视频时长与当前时间
  const handleLoadedMetadata = () => {
    if (videoRef.current && videoRef.current.duration > 0) {
      setDuration(videoRef.current.duration)
    }
  }

  const togglePlay = () => {
    if (!videoRef.current) return
    if (isPlaying) {
      videoRef.current.pause()
      setIsPlaying(false)
    } else {
      videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {})
    }
  }

  const handleSeek = (newTime: number) => {
    setCurrentTime(newTime)
    if (videoRef.current) {
      videoRef.current.currentTime = newTime
    }
  }

  const handleVolumeChange = (v: number) => {
    setVolume(v)
    setIsMuted(v === 0)
    if (videoRef.current) {
      videoRef.current.volume = v
      videoRef.current.muted = v === 0
    }
  }

  const toggleMute = () => {
    if (!videoRef.current) return
    const nextMute = !isMuted
    setIsMuted(nextMute)
    videoRef.current.muted = nextMute
  }

  const toggleFullscreen = () => {
    if (!videoContainerRef.current) return
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      videoContainerRef.current.requestFullscreen().catch(() => {})
    }
  }

  const copyTaskId = () => {
    navigator.clipboard.writeText(taskId)
    setCopiedId(true)
    setTimeout(() => setCopiedId(false), 2000)
  }

  const headerRef = useRef<HTMLDivElement>(null)

  // 处理时间轴拖拽定位
  const updateTimelineSeek = (clientX: number, forceCommit: boolean = false) => {
    if (!timelineRef.current || duration <= 0) return
    const rect = timelineRef.current.getBoundingClientRect()
    const labelWidth = headerRef.current?.offsetWidth || 176
    const clickX = clientX - rect.left - labelWidth
    const trackWidth = rect.width - labelWidth
    if (clickX < 0) return
    const ratio = Math.max(0, Math.min(1, clickX / trackWidth))
    const seekTime = ratio * duration

    setCurrentTime(seekTime)

    const now = performance.now()
    if (forceCommit || now - lastVideoUpdate.current > 100) {
      if (videoRef.current) {
        videoRef.current.currentTime = seekTime
      }
      lastVideoUpdate.current = now
      pendingSeekRef.current = null
    } else {
      pendingSeekRef.current = seekTime
    }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    isDraggingRef.current = true
    setIsDraggingUI(true)
    updateTimelineSeek(e.clientX, true)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    updateTimelineSeek(e.clientX, false)
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false
    setIsDraggingUI(false)
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (pendingSeekRef.current !== null) {
      if (videoRef.current) {
        videoRef.current.currentTime = pendingSeekRef.current
      }
      pendingSeekRef.current = null
    }
  }

  // 根据当前视频时间动态同步字幕文本
  const activeSubtitle = showSubtitles
    ? subtitles.find((s) => currentTime >= s.start && currentTime <= s.end)?.translated_text ||
      (subtitles.length > 0 && currentTime === 0 ? subtitles[0].translated_text : null)
    : null

  // 计算播放头左侧百分比
  const playheadPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0

  return (
    <div className="flex-grow flex flex-col p-4 sm:p-6 max-w-7xl mx-auto w-full select-none">
      {/* 单一一体化工作台面板 */}
      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 shadow-xl dark:shadow-2xl overflow-hidden flex flex-col">

        {/* 顶部集成式工具栏 */}
        <div className="bg-slate-50/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800 px-5 py-3.5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-500/20 text-xs font-semibold">
              <Sparkles className="w-3.5 h-3.5 text-emerald-500 animate-pulse" />
              🎉 任务已完成
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 font-mono bg-white dark:bg-slate-800/60 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700/60 shadow-2xs">
              <span>ID: {taskId.substring(0, 8)}...</span>
              <button
                onClick={copyTaskId}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors p-0.5 cursor-pointer"
                title="复制 Task ID"
              >
                {copiedId ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={onReset}
              className="bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl text-xs gap-2 cursor-pointer shadow-2xs"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              新建任务
            </Button>

            {/* 导出视频按钮 - 适配浅色/深色模式 */}
            <DropdownMenu>
              <DropdownMenuTrigger className="bg-purple-600 hover:bg-purple-700 text-white font-semibold text-xs px-4 py-2 rounded-xl flex items-center gap-2 transition-all cursor-pointer border-none shadow-sm outline-none">
                <Download className="w-3.5 h-3.5" />
                导出视频
                <span className="text-[10px] bg-white/20 px-1.5 py-0.5 rounded font-normal flex items-center gap-0.5">
                  1080P <ChevronDown className="w-3 h-3" />
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200 w-48 rounded-xl p-1.5 shadow-xl">
                <DropdownMenuItem
                  onClick={() => {
                    const exportFilename = getExportFilename(taskStatus?.filename, taskStatus?.target_lang)
                    const a = document.createElement('a')
                    a.href = exportUrl
                    a.download = exportFilename
                    a.click()
                  }}
                  className="flex justify-between items-center bg-purple-50 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300 font-medium rounded-lg text-xs cursor-pointer px-3 py-2"
                >
                  1080P Full HD <Check className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                </DropdownMenuItem>
                <DropdownMenuItem className="flex justify-between items-center hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-xs cursor-pointer text-slate-600 dark:text-slate-400 px-3 py-2">
                  4K HDR 超清 <Crown className="w-3.5 h-3.5 text-amber-500" />
                </DropdownMenuItem>
                <DropdownMenuItem className="hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-xs cursor-pointer text-slate-600 dark:text-slate-400 px-3 py-2">
                  720P 高清
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-slate-100 dark:bg-slate-800" />
                <DropdownMenuItem
                  onClick={() => {
                    const a = document.createElement('a')
                    a.href = ttsAudioUrl
                    a.download = ''
                    a.click()
                  }}
                  className="hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-xs cursor-pointer text-slate-700 dark:text-slate-300 px-3 py-2"
                >
                  仅导出 AI 配音 (WAV)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* 中间：巨幕视频播放器视口 */}
        <div
          ref={videoContainerRef}
          className="relative group bg-[#0F172A] dark:bg-[#090D16] flex flex-col items-center justify-center min-h-[380px] lg:min-h-[440px] border-b border-slate-200/80 dark:border-slate-800"
        >
          {/* 顶部模式标签 */}
          <div className="absolute top-4 left-4 z-20 bg-black/40 backdrop-blur-md px-3.5 py-1.5 rounded-full text-xs font-medium text-white/90 border border-white/10 flex items-center gap-2 shadow-lg">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
            实时预览模式
          </div>

          {/* 真实视频播放器 */}
          <video
            ref={videoRef}
            src={videoUrl}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={() => setIsPlaying(false)}
            onClick={togglePlay}
            className="w-full h-full max-h-[480px] object-contain cursor-pointer"
            playsInline
          />

          {/* 悬浮字幕显示区 */}
          {activeSubtitle && (
            <div className="absolute bottom-20 left-1/2 -translate-x-1/2 px-6 py-2 rounded-2xl bg-black/70 backdrop-blur-md border border-white/15 shadow-2xl text-center max-w-3xl pointer-events-none z-10">
              <p className="text-lg sm:text-2xl font-bold text-white tracking-wide drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">
                {activeSubtitle}
              </p>
            </div>
          )}

          {/* 居中播放按钮浮层 */}
          {!isPlaying && (
            <button
              onClick={togglePlay}
              className="absolute z-20 w-16 h-16 rounded-full bg-purple-600/85 backdrop-blur-md text-white flex items-center justify-center shadow-2xl hover:scale-110 transition-transform cursor-pointer hover:bg-purple-600 border border-white/20"
            >
              <Play className="w-7 h-7 ml-1" fill="white" />
            </button>
          )}

          {/* 玻璃质感悬浮控制条 */}
          <div className="absolute bottom-4 left-4 right-4 h-14 bg-slate-900/80 dark:bg-slate-900/80 backdrop-blur-xl rounded-2xl border border-white/15 flex items-center px-4 sm:px-6 gap-4 text-white/90 shadow-2xl z-20 transition-opacity duration-300 group-hover:opacity-100 opacity-95">
            <button onClick={togglePlay} className="hover:text-purple-400 transition-colors p-1 cursor-pointer">
              {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
            </button>

            <span className="text-xs font-mono tracking-wider shrink-0 text-slate-300">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            <div className="flex-grow flex items-center px-2">
              <Slider
                value={[currentTime]}
                min={0}
                max={duration || 100}
                step={0.1}
                onValueChange={(val) => {
                  const num = typeof val === 'number' ? val : Array.isArray(val) ? val[0] : 0
                  setCurrentTime(num)
                  const now = performance.now()
                  if (now - lastVideoUpdate.current > 100) {
                    if (videoRef.current) videoRef.current.currentTime = num
                    lastVideoUpdate.current = now
                  }
                }}
                className="w-full cursor-pointer relative flex items-center [&_[data-slot=slider-track]]:!h-1.5 [&_[data-slot=slider-track]]:!w-full [&_[data-slot=slider-track]]:bg-white/20 [&_[data-slot=slider-thumb]]:!w-3.5 [&_[data-slot=slider-thumb]]:!h-3.5 [&_[data-slot=slider-thumb]]:!border-none [&_[data-slot=slider-thumb]]:!bg-purple-500 [&_[data-slot=slider-thumb]]:shadow-[0_0_10px_rgba(168,85,247,0.8)]"
              />
            </div>

            <div className="flex items-center gap-3 border-l border-white/10 pl-4">
              <div className="flex items-center gap-2 group/vol">
                <button onClick={toggleMute} className="hover:text-purple-400 transition-colors p-1 cursor-pointer">
                  {isMuted || volume === 0 ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4" />}
                </button>
                <div className="w-16 hidden sm:block">
                  <Slider
                    value={[isMuted ? 0 : volume]}
                    min={0}
                    max={1}
                    step={0.05}
                    onValueChange={(val) => {
                      const num = typeof val === 'number' ? val : Array.isArray(val) ? val[0] : 0
                      handleVolumeChange(num)
                    }}
                    className="[&>span:first-child]:h-1 [&_[role=slider]]:w-3 [&_[role=slider]]:h-3 [&_[role=slider]]:bg-white"
                  />
                </div>
              </div>

              <button
                onClick={() => setShowSubtitles((prev) => !prev)}
                className={`p-1 transition-colors cursor-pointer ${showSubtitles ? 'text-purple-400' : 'text-slate-400'}`}
                title="切换字幕显示"
              >
                <Captions className="w-4 h-4" />
              </button>

              <button onClick={toggleFullscreen} className="hover:text-purple-400 transition-colors p-1 cursor-pointer">
                <Maximize className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* 底部：横向多轨时间轴 */}
        <div className="bg-[#F1F5F9] dark:bg-[#0B1121] p-4 sm:p-5 flex flex-col space-y-3 relative">
          {/* 时间轴标题栏 */}
          <div className="flex items-center justify-between pb-2 px-2">
            <div className="flex items-center gap-2">
              <Film className="w-4 h-4 text-slate-500 dark:text-slate-400" />
              <h3 className="text-[13px] font-bold text-slate-700 dark:text-slate-300 tracking-wider">
                时间轴 (Timeline)
              </h3>
            </div>
            <div className="flex items-center gap-4">
              {/* 缩放控件 */}
              <div className="flex items-center gap-2.5 bg-white dark:bg-slate-800/60 px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700/50 shadow-2xs">
                <button onClick={() => setZoomScale(Math.max(1, zoomScale - 0.5))} className="p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer">
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <div className="w-20 flex items-center">
                  <Slider
                    value={[zoomScale]}
                    min={1}
                    max={20}
                    step={0.1}
                    onValueChange={(val) => {
                      const num = typeof val === 'number' ? val : Array.isArray(val) ? val[0] : 1
                      setZoomScale(num)
                    }}
                    className="w-full cursor-pointer relative flex items-center [&_[data-slot=slider-track]]:!h-1 [&_[data-slot=slider-track]]:!w-full [&_[data-slot=slider-track]]:bg-slate-300 dark:[&_[data-slot=slider-track]]:bg-slate-600 [&_[data-slot=slider-thumb]]:!w-3 [&_[data-slot=slider-thumb]]:!h-3 [&_[data-slot=slider-thumb]]:!border-none [&_[data-slot=slider-thumb]]:!bg-purple-500"
                  />
                </div>
                <button onClick={() => setZoomScale(Math.min(20, zoomScale + 0.5))} className="p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer">
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                <div className="w-px h-3 bg-slate-200 dark:bg-slate-700 mx-0.5" />
                <button onClick={() => setZoomScale(1)} className="p-0.5 text-slate-400 hover:text-purple-600 dark:hover:text-purple-400 transition-colors cursor-pointer" title="适应全局 (Fit to Timeline)">
                  <Maximize className="w-3.5 h-3.5" />
                </button>
              </div>

              <span className="text-[11px] font-mono text-slate-600 dark:text-slate-400">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
          </div>

          {/* 支持横向滚动的时间轴视口 */}
          <div
            ref={timelineScrollRef}
            className="relative w-full border border-slate-200 dark:border-slate-800/60 rounded-md bg-[#F8FAFC] dark:bg-[#0F172A] shadow-sm overflow-x-auto overflow-y-hidden"
          >
            {/* 内部缩放画布 */}
            <div
              ref={timelineRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              style={{ width: `calc(176px + (100% - 176px) * ${zoomScale})`, minWidth: '100%' }}
              className={`relative flex flex-col pt-12 pb-2 select-none group/timeline touch-none ${isDraggingUI ? 'cursor-grabbing' : 'cursor-default'}`}
            >
              {/* 顶栏时间刻度尺 */}
              <div className="absolute top-5 left-44 right-0 h-6 border-b border-slate-200 dark:border-slate-800/80 pointer-events-none flex items-end overflow-hidden bg-slate-100/50 dark:bg-slate-900/50">
                <svg className="w-full h-full" preserveAspectRatio="none">
                  {Array.from({ length: Math.floor(100 * zoomScale) }).map((_, i) => (
                      <rect key={i} x={`${(i / Math.floor(100 * zoomScale)) * 100}%`} y={i % 10 === 0 ? "40%" : "70%"} width="1" height="100%" fill="currentColor" className="text-slate-300 dark:text-slate-600" />
                  ))}
                </svg>
                {/* 标签 */}
                <div className="absolute top-1 left-0 right-0 h-full text-[9px] font-mono text-slate-400">
                  {Array.from({ length: Math.floor(10 * zoomScale) + 1 }).map((_, i, arr) => {
                    const pct = i / (arr.length - 1)
                    const time = duration * pct
                    return (
                      <span key={i} className="absolute" style={{ left: `${pct * 100}%`, transform: 'translateX(-50%)' }}>
                        {formatTime(time)}
                      </span>
                    )
                  })}
                </div>
              </div>

              {/* 贯穿式垂直播放头指示线 */}
              <div
                className="absolute top-5 bottom-0 w-px z-40"
                style={{ left: `calc(176px + (100% - 176px) * ${playheadPercent / 100})` }}
              >
                {/* 实际的红线 */}
                <div className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none" />

                {/* 宽广的隐形拖拽热区 */}
                <div className={`absolute -top-5 bottom-0 -left-4 w-8 touch-none z-50 ${isDraggingUI ? 'cursor-grabbing' : 'cursor-grab hover:bg-red-500/10'} transition-colors`} />

                <div className="absolute -top-[18px] left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none">
                  <span className="text-[9px] font-mono text-red-500 font-bold mb-[1px]">
                    {formatTime(currentTime)}
                  </span>
                  <svg width="9" height="10" viewBox="0 0 9 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M0 1.5C0 0.671573 0.671573 0 1.5 0H7.5C8.32843 0 9 0.671573 9 1.5V6L4.5 10L0 6V1.5Z" fill="#EF4444"/>
                  </svg>
                </div>
              </div>

              {/* 轨道 1: 画面轨道 V1 */}
              <div className="flex items-center relative -mt-px group hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div ref={headerRef} className="w-44 shrink-0 flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 border-r border-slate-200 dark:border-slate-800/80 pl-3 py-3 z-30 sticky left-0 bg-[#F8FAFC] dark:bg-[#0F172A]">
                  <Video className="w-3.5 h-3.5 text-slate-400" />
                  <span>画面轨道 V1</span>
                </div>
                <div className="flex-grow h-[46px] border-y border-slate-200/60 dark:border-slate-800/60 relative flex items-center p-[2px] overflow-hidden">
                  <div className="w-full h-full bg-slate-200 dark:bg-slate-800 rounded-[3px] relative overflow-hidden flex gap-px">
                    {thumbnails.length > 0 ? (
                      Array.from({ length: Math.floor(30 * zoomScale) }).map((_, i) => {
                        const thumbIndex = Math.floor((i / (30 * zoomScale)) * thumbnails.length)
                        return (
                          <div key={i} className="flex-1 h-full border-r border-black/20 dark:border-white/10 last:border-r-0 relative">
                            <img src={thumbnails[thumbIndex]} className="absolute inset-0 w-full h-full object-cover pointer-events-none" />
                          </div>
                        )
                      })
                    ) : (
                      Array.from({ length: Math.floor(30 * zoomScale) }).map((_, i) => (
                        <div key={i} className="flex-1 h-full bg-slate-300/80 dark:bg-slate-700/80 flex items-center justify-center border-r border-slate-400/20 dark:border-slate-600/20 last:border-r-0">
                          <Film className="w-3 h-3 text-white/40" />
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* 轨道 2: 智能字幕 S1 */}
              <div className="flex items-center relative -mt-px group hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div className="w-44 shrink-0 flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 border-r border-slate-200 dark:border-slate-800/80 pl-3 py-3 z-30 sticky left-0 bg-[#F8FAFC] dark:bg-[#0F172A]">
                  <Type className="w-3.5 h-3.5 text-slate-400" />
                  <span>智能字幕 S1</span>
                </div>
                <div className="flex-grow h-[46px] border-y border-slate-200/60 dark:border-slate-800/60 relative flex items-center p-[2px]">
                  {subtitles.length > 0 ? (
                    subtitles.map((seg, i) => {
                      const leftPct = duration > 0 ? (seg.start / duration) * 100 : i * 25
                      const widthPct = duration > 0 ? ((seg.end - seg.start) / duration) * 100 : 22
                      const isActive = currentTime >= seg.start && currentTime <= seg.end

                      return (
                        <div
                          key={i}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleSeek(seg.start)
                          }}
                          className={`absolute h-full top-0 py-[3px] transition-all cursor-pointer z-10 ${isActive ? 'z-20' : ''}`}
                          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                          title={`${formatTime(seg.start)} - ${formatTime(seg.end)}: ${seg.translated_text}`}
                        >
                          <div className={`w-full h-full rounded-[3px] flex items-center px-1.5 text-[11px] whitespace-nowrap overflow-hidden text-ellipsis border ${
                            isActive
                              ? 'bg-purple-200/90 dark:bg-purple-800/90 border-purple-400 dark:border-purple-500 text-purple-900 dark:text-purple-100 font-bold shadow-sm'
                              : 'bg-purple-100/70 dark:bg-purple-900/40 border-purple-200/80 dark:border-purple-800/60 text-purple-800 dark:text-purple-300 hover:bg-purple-200/80'
                          }`}>
                            {seg.translated_text}
                          </div>
                        </div>
                      )
                    })
                  ) : (
                    <>
                      <div className="absolute left-[5%] w-[35%] h-full py-[3px]">
                        <div className="w-full h-full bg-purple-100/70 dark:bg-purple-900/40 border border-purple-200/80 dark:border-purple-800/60 rounded-[3px] flex items-center px-1.5 text-[11px] text-purple-800 dark:text-purple-300 truncate">
                          欢迎收看今天的科技前沿探索...
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* 轨道 3: AI 译音配音 A1 */}
              <div className="flex items-center relative -mt-px group hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div className="w-44 shrink-0 flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-300 border-r border-slate-200 dark:border-slate-800/80 pl-3 pr-2 py-3 z-30 sticky left-0 bg-[#F8FAFC] dark:bg-[#0F172A]">
                  <div className="flex items-center gap-2">
                    <AudioWaveform className="w-3.5 h-3.5 text-slate-400" />
                    <span>AI 配音 A1</span>
                  </div>
                  <span className="text-[10px] bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded font-normal">
                    冰糖
                  </span>
                </div>
                <div className="flex-grow h-[46px] border-y border-slate-200/60 dark:border-slate-800/60 relative flex items-center p-[2px]">
                  <div className="w-full h-full bg-blue-100/60 dark:bg-blue-900/40 border border-blue-200/80 dark:border-blue-800/60 rounded-[3px] relative overflow-hidden flex items-center">
                    <svg className="w-full h-full opacity-60" viewBox="0 0 1000 40" preserveAspectRatio="none">
                      {Array.from({ length: 500 }).map((_, idx) => {
                        const h = Math.abs(Math.sin(idx * 0.13) * 14 + Math.cos(idx * 0.47) * 8 + Math.sin(idx * 0.05) * 12) + 4
                        const displayH = Math.max(1, Math.min(38, h))
                        return (
                          <rect
                            key={idx}
                            x={idx * 2}
                            y={20 - displayH / 2}
                            width={1}
                            height={displayH}
                            fill="currentColor"
                            className="text-blue-600 dark:text-blue-400"
                          />
                        )
                      })}
                    </svg>
                  </div>
                </div>
              </div>

              {/* 轨道 4: 背景原声 A2 */}
              <div className="flex items-center relative -mt-px group hover:bg-black/5 dark:hover:bg-white/5 transition-colors opacity-80">
                <div className="w-44 shrink-0 flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 border-r border-slate-200 dark:border-slate-800/80 pl-3 py-3 z-30 sticky left-0 bg-[#F8FAFC] dark:bg-[#0F172A]">
                  <Music className="w-3.5 h-3.5 text-slate-400" />
                  <span>背景原声 A2</span>
                </div>
                <div className="flex-grow h-[46px] border-y border-slate-200/60 dark:border-slate-800/60 relative flex items-center p-[2px]">
                  <div className="w-full h-full bg-slate-200/60 dark:bg-slate-800/60 border border-slate-300/60 dark:border-slate-700/60 rounded-[3px] relative overflow-hidden flex items-center">
                    <svg className="w-full h-full opacity-40" viewBox="0 0 1000 40" preserveAspectRatio="none">
                      {Array.from({ length: 500 }).map((_, idx) => {
                        const h = Math.abs(Math.cos(idx * 0.11) * 10 + Math.sin(idx * 0.37) * 6 + Math.cos(idx * 0.08) * 8) + 2
                        const displayH = Math.max(1, Math.min(38, h))
                        return (
                          <rect
                            key={idx}
                            x={idx * 2}
                            y={20 - displayH / 2}
                            width={1}
                            height={displayH}
                            fill="currentColor"
                            className="text-slate-500 dark:text-slate-400"
                          />
                        )
                      })}
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
