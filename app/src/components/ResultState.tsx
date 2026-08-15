import { useEffect, useState, useRef, useMemo, memo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Download, ChevronDown, Check,
  Play, Pause, Volume2, VolumeX, Captions, Maximize, Video, Type, AudioWaveform,
  Music, RotateCcw, Copy, Sparkles, Film, ZoomIn, ZoomOut,
  Search, FileText, Send, BookOpen, RefreshCw,
  Languages, Compass, Clock, Bot, Wand2, CheckCircle2, Lightbulb, BookMarked, HelpCircle, FileDown, ListFilter, Activity,
  Trash2
} from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { getSubtitles, getAudioUrl, getExportUrl, getVideoUrl, getTaskStatus, analyzeSubtitlesAI, type SubtitleSegment, type TaskStatus } from '@/lib/api'
import { loadSettings } from './SettingsPanel'

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

function formatTimestampSRT(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00:00,000'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

function formatTimestampVTT(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00:00.000'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

function exportSubtitlesSRT(subtitles: SubtitleSegment[]): string {
  return subtitles
    .map((s, idx) => {
      const start = formatTimestampSRT(s.start)
      const end = formatTimestampSRT(s.end)
      const text = s.translated_text || s.source_text
      const orig = s.source_text && s.translated_text && s.source_text !== s.translated_text ? `\n${s.source_text}` : ''
      return `${idx + 1}\n${start} --> ${end}\n${text}${orig}\n`
    })
    .join('\n')
}

function exportSubtitlesVTT(subtitles: SubtitleSegment[]): string {
  const header = 'WEBVTT - 译视宝自动导出字幕\n\n'
  const body = subtitles
    .map((s, idx) => {
      const start = formatTimestampVTT(s.start)
      const end = formatTimestampVTT(s.end)
      const text = s.translated_text || s.source_text
      return `${idx + 1}\n${start} --> ${end}\n${text}\n`
    })
    .join('\n')
  return header + body
}

function exportSubtitlesTXT(subtitles: SubtitleSegment[]): string {
  return subtitles
    .map((s) => {
      const ts = formatTime(s.start)
      const text = s.translated_text || s.source_text
      const orig = s.source_text && s.translated_text && s.source_text !== s.translated_text ? ` (原文: ${s.source_text})` : ''
      return `[${ts}] ${text}${orig}`
    })
    .join('\n')
}

function downloadTextFile(filename: string, content: string, mime: string = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
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

function getResolutionShortLabel(height: number | null): string {
  if (!height || height <= 0) return '原画'
  if (height >= 2160) return '4K'
  if (height >= 1440) return '2K'
  if (height >= 1080) return '1080P'
  if (height >= 720) return '720P'
  if (height >= 480) return '480P'
  return `${height}P`
}

function getResolutionFullLabel(height: number | null): string {
  if (!height || height <= 0) return '原画画质'
  if (height >= 2160) return '4K HDR 超清'
  if (height >= 1440) return '2K 超清'
  if (height >= 1080) return '1080P Full HD'
  if (height >= 720) return '720P 高清'
  if (height >= 480) return '480P 标清'
  return `${height}P`
}

interface QualityOption {
  id: string
  label: string
  shortLabel: string
  isOriginal: boolean
}

function getExportQualityOptions(height: number | null): QualityOption[] {
  if (!height || height <= 0) {
    return [
      { id: 'original', label: '原画画质', shortLabel: '原画', isOriginal: true }
    ]
  }

  const mainShort = getResolutionShortLabel(height)
  const mainFull = getResolutionFullLabel(height)

  const options: QualityOption[] = [
    {
      id: `res-${height}`,
      label: `${mainFull} (原画)`,
      shortLabel: mainShort,
      isOriginal: true,
    }
  ]

  const standardLevels = [
    { minHeight: 1440, label: '2K 超清', shortLabel: '2K' },
    { minHeight: 1080, label: '1080P Full HD', shortLabel: '1080P' },
    { minHeight: 720, label: '720P 高清', shortLabel: '720P' },
    { minHeight: 480, label: '480P 标清', shortLabel: '480P' },
  ]

  for (const level of standardLevels) {
    if (height > level.minHeight) {
      options.push({
        id: `res-${level.minHeight}`,
        label: level.label,
        shortLabel: level.shortLabel,
        isOriginal: false,
      })
    }
  }

  return options
}

interface SubtitleItemCardProps {
  seg: SubtitleSegment
  isActive: boolean
  subtitleDisplayMode: 'dual' | 'target' | 'source'
  onSeek: (time: number) => void
  itemRef?: (el: HTMLDivElement | null) => void
}

const SubtitleItemCard = memo(function SubtitleItemCard({
  seg,
  isActive,
  subtitleDisplayMode,
  onSeek,
  itemRef,
}: SubtitleItemCardProps) {
  return (
    <div
      ref={itemRef}
      onClick={() => onSeek(seg.start)}
      className={`p-3.5 rounded-2xl border transition-all cursor-pointer relative group ${
        isActive
          ? 'bg-purple-50/90 dark:bg-purple-950/70 border-purple-500 text-purple-950 dark:text-purple-100 shadow-md ring-1 ring-purple-500/40'
          : 'bg-white dark:bg-slate-800/40 border-slate-200/80 dark:border-slate-800 text-slate-800 dark:text-slate-200 hover:border-purple-300 dark:hover:border-purple-700 hover:bg-purple-50/30'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] font-mono px-2 py-0.5 rounded-md border flex items-center gap-1 ${
              isActive
                ? 'bg-purple-600 text-white border-purple-500 font-bold'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
            }`}
          >
            <Clock className="w-3 h-3 opacity-80" />
            {formatTime(seg.start)} - {formatTime(seg.end)}
          </span>
          {isActive && (
            <span className="flex items-center gap-1 text-[10px] text-purple-600 dark:text-purple-300 font-semibold animate-pulse">
              <Activity className="w-3 h-3 text-purple-600 dark:text-purple-400" />
              播放中
            </span>
          )}
        </div>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded-md">
          #{seg.index + 1}
        </span>
      </div>

      {(subtitleDisplayMode === 'dual' || subtitleDisplayMode === 'target') && (
        <p
          className={`text-xs sm:text-sm font-medium leading-snug ${
            isActive ? 'text-purple-900 dark:text-purple-100 font-semibold' : 'text-slate-900 dark:text-slate-100'
          }`}
        >
          {seg.translated_text || seg.source_text}
        </p>
      )}

      {(subtitleDisplayMode === 'dual' || subtitleDisplayMode === 'source') && seg.source_text && (
        <p
          className={`text-[11px] leading-snug mt-1 ${
            subtitleDisplayMode === 'dual'
              ? 'text-slate-500 dark:text-slate-400 font-normal border-t border-slate-100 dark:border-slate-700/60 pt-1.5'
              : 'text-slate-700 dark:text-slate-300'
          }`}
        >
          {seg.source_text}
        </p>
      )}
    </div>
  )
})

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
  const [videoHeight, setVideoHeight] = useState<number | null>(null)
  const [selectedQualityId, setSelectedQualityId] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [subtitlePos, setSubtitlePos] = useState<{ x: number; y: number } | null>(null)
  const [isDraggingSub, setIsDraggingSub] = useState(false)

  // 右侧字幕与 AI 学习面板状态
  const [rightPanelTab, setRightPanelTab] = useState<'subtitles' | 'ai'>('subtitles')
  const [subtitleFilter, setSubtitleFilter] = useState('')
  const [subtitleDisplayMode, setSubtitleDisplayMode] = useState<'dual' | 'target' | 'source'>('dual')
  const [autoScrollSubtitles, setAutoScrollSubtitles] = useState(true)
  const [copiedSubtitles, setCopiedSubtitles] = useState(false)
  const [copiedAi, setCopiedAi] = useState(false)

  // AI 分析状态
  const [aiMode, setAiMode] = useState<'summary' | 'study_notes' | 'qa' | 'custom'>('summary')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiAnalysisResult, setAiAnalysisResult] = useState<string>('')

  // AI 对话问答 (Chat Thread) 状态
  const [chatMessages, setChatMessages] = useState<Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: string }>>([
    {
      id: 'welcome-1',
      role: 'assistant',
      content:
        '👋 **你好！我是 AI 视频助教。**\n\n你可以向我询问任何关于本视频的内容，例如“用三句话概括重点”、“解释视频中的核心概念”或“提取 3 个重要结论”。',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ])
  const [chatInput, setChatInput] = useState('')
  const [isSendingChat, setIsSendingChat] = useState(false)
  const chatBottomRef = useRef<HTMLDivElement>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const timelineScrollRef = useRef<HTMLDivElement>(null)
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const subDragStartRef = useRef<{ mouseX: number; mouseY: number; startX: number; startY: number } | null>(null)
  const subListRef = useRef<HTMLDivElement>(null)
  const subItemRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const lastScrolledIndex = useRef<number | null>(null)

  // Memoize 过滤后的字幕列表，避免重绘重复计算
  const filteredSubtitles = useMemo(() => {
    if (!subtitleFilter.trim()) return subtitles
    const query = subtitleFilter.toLowerCase()
    return subtitles.filter(
      (seg) => seg.translated_text.toLowerCase().includes(query) || seg.source_text.toLowerCase().includes(query)
    )
  }, [subtitles, subtitleFilter])

  // Memoize 轨道 3 的 SVG 音频波形 (180 柱形 rounded bar)，避免每一帧重复计算/生成 DOM 节点
  const audioWaveformA1 = useMemo(() => {
    return Array.from({ length: 180 }).map((_, idx) => {
      const h = Math.abs(Math.sin(idx * 0.13) * 14 + Math.cos(idx * 0.47) * 8 + Math.sin(idx * 0.05) * 12) + 4
      const displayH = Math.max(1, Math.min(38, h))
      return (
        <rect
          key={idx}
          x={idx * 5.5}
          y={20 - displayH / 2}
          width={3}
          height={displayH}
          rx={1.5}
          fill="currentColor"
          className="text-blue-600 dark:text-blue-400"
        />
      )
    })
  }, [])

  // Memoize 轨道 4 的 SVG 原声波形
  const audioWaveformA2 = useMemo(() => {
    return Array.from({ length: 180 }).map((_, idx) => {
      const h = Math.abs(Math.cos(idx * 0.11) * 10 + Math.sin(idx * 0.37) * 6 + Math.cos(idx * 0.08) * 8) + 2
      const displayH = Math.max(1, Math.min(38, h))
      return (
        <rect
          key={idx}
          x={idx * 5.5}
          y={20 - displayH / 2}
          width={3}
          height={displayH}
          rx={1.5}
          fill="currentColor"
          className="text-slate-500 dark:text-slate-400"
        />
      )
    })
  }, [])

  // 实时查找当前帧播放到的字幕片段索引
  const activeSubIndex = subtitles.findIndex(
    (seg) => currentTime >= seg.start && currentTime <= seg.end
  )

  // 虚拟化渲染引擎，优化超长视频（1000+ 字幕）的列表重绘与内存占用
  const rowVirtualizer = useVirtualizer({
    count: filteredSubtitles.length,
    getScrollElement: () => subListRef.current,
    estimateSize: () => 100,
    overscan: 6,
  })

  // 当视频播放时间变动时，右侧对应字幕在字幕列表容器内部平滑滑动居中定位 (绝对隔离外层 window，禁止连带滚动整个页面)
  useEffect(() => {
    if (!autoScrollSubtitles || activeSubIndex === -1 || rightPanelTab !== 'subtitles') return
    if (lastScrolledIndex.current === activeSubIndex) return

    const targetIdx = filteredSubtitles.findIndex((s) => s.index === activeSubIndex)
    if (targetIdx !== -1) {
      rowVirtualizer.scrollToIndex(targetIdx, {
        align: 'center',
        behavior: 'smooth',
      })
      lastScrolledIndex.current = activeSubIndex
    }
  }, [activeSubIndex, autoScrollSubtitles, rightPanelTab, filteredSubtitles, rowVirtualizer])

  // 执行 AI 分析与提炼
  const handleRunAIAnalysis = async (mode: 'summary' | 'study_notes' | 'qa' | 'custom', customPrompt?: string) => {
    setAiLoading(true)
    setAiMode(mode)
    try {
      const appSettings = loadSettings()
      const res = await analyzeSubtitlesAI(taskId, {
        mode,
        custom_prompt: customPrompt,
        gemini_api_key: appSettings.geminiApiKey,
        gemini_api_url: appSettings.geminiApiUrl,
        gemini_api_format: appSettings.geminiApiFormat,
        gemini_model: appSettings.geminiModel,
      })
      if (res.analysis) {
        setAiAnalysisResult(res.analysis)
      }
    } catch (err) {
      console.error('AI analysis error:', err)
      setAiAnalysisResult(`⚠️ AI 分析请求错误: ${err instanceof Error ? err.message : '请重试或检查配置'}`)
    } finally {
      setAiLoading(false)
    }
  }

  // 仅在对话列表内部平滑滚动到底部，避免影响外层页面
  useEffect(() => {
    if (rightPanelTab === 'ai' && aiMode === 'qa' && chatBottomRef.current?.parentElement) {
      const container = chatBottomRef.current.parentElement
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, [chatMessages, rightPanelTab, aiMode, isSendingChat])

  // 发送 Chat 问答消息
  const handleSendChatMessage = async (promptText?: string) => {
    const text = (promptText || chatInput).trim()
    if (!text || isSendingChat) return

    const userMsg = {
      id: `user-${Date.now()}`,
      role: 'user' as const,
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }

    setChatMessages((prev) => [...prev, userMsg])
    if (!promptText) setChatInput('')
    setIsSendingChat(true)

    try {
      const appSettings = loadSettings()
      const res = await analyzeSubtitlesAI(taskId, {
        mode: 'qa',
        custom_prompt: text,
        gemini_api_key: appSettings.geminiApiKey,
        gemini_api_url: appSettings.geminiApiUrl,
        gemini_api_format: appSettings.geminiApiFormat,
        gemini_model: appSettings.geminiModel,
      })

      const aiMsg = {
        id: `ai-${Date.now()}`,
        role: 'assistant' as const,
        content: res.analysis || 'AI 暂时未能提取回答，请重试或检查配置。',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }
      setChatMessages((prev) => [...prev, aiMsg])
    } catch (err) {
      console.error('Chat AI error:', err)
      const errorMsg = {
        id: `err-${Date.now()}`,
        role: 'assistant' as const,
        content: `⚠️ **请求发生错误**: ${err instanceof Error ? err.message : '请重试或检查 API 配置'}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }
      setChatMessages((prev) => [...prev, errorMsg])
    } finally {
      setIsSendingChat(false)
    }
  }

  const handleClearChatHistory = () => {
    setChatMessages([
      {
        id: `welcome-${Date.now()}`,
        role: 'assistant',
        content: '👋 已清空历史对话。请输入新的问题向 AI 提问！',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ])
  }

  // 导出字幕文件
  const handleExportSubtitles = (format: 'srt' | 'vtt' | 'txt' | 'json') => {
    if (!subtitles || subtitles.length === 0) return
    const baseName = taskStatus?.filename
      ? taskStatus.filename.substring(0, taskStatus.filename.lastIndexOf('.')) || taskStatus.filename
      : 'subtitles'

    if (format === 'srt') {
      const content = exportSubtitlesSRT(subtitles)
      downloadTextFile(`${baseName}_字幕.srt`, content, 'text/plain;charset=utf-8')
    } else if (format === 'vtt') {
      const content = exportSubtitlesVTT(subtitles)
      downloadTextFile(`${baseName}_字幕.vtt`, content, 'text/vtt;charset=utf-8')
    } else if (format === 'txt') {
      const content = exportSubtitlesTXT(subtitles)
      downloadTextFile(`${baseName}_字幕.txt`, content, 'text/plain;charset=utf-8')
    } else if (format === 'json') {
      const content = JSON.stringify(subtitles, null, 2)
      downloadTextFile(`${baseName}_字幕.json`, content, 'application/json;charset=utf-8')
    }
  }

  const handleCopyAllSubtitles = () => {
    if (!subtitles || subtitles.length === 0) return
    const text = exportSubtitlesTXT(subtitles)
    navigator.clipboard.writeText(text)
    setCopiedSubtitles(true)
    setTimeout(() => setCopiedSubtitles(false), 2000)
  }

  const handleSubPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setIsDraggingSub(true)
    subDragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: subtitlePos?.x || 0,
      startY: subtitlePos?.y || 0,
    }
  }

  const handleSubPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingSub || !subDragStartRef.current) return
    e.stopPropagation()
    const dx = e.clientX - subDragStartRef.current.mouseX
    const dy = e.clientY - subDragStartRef.current.mouseY

    let containerWidth = 800
    let containerHeight = 450
    if (videoContainerRef.current) {
      containerWidth = videoContainerRef.current.clientWidth
      containerHeight = videoContainerRef.current.clientHeight
    }
    const maxDx = containerWidth / 2 - 40
    const minDx = -maxDx
    const minDy = -containerHeight + 100
    const maxDy = 60

    const newX = Math.max(minDx, Math.min(maxDx, subDragStartRef.current.startX + dx))
    const newY = Math.max(minDy, Math.min(maxDy, subDragStartRef.current.startY + dy))

    setSubtitlePos({ x: newX, y: newY })
  }

  const handleSubPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingSub) return
    e.stopPropagation()
    setIsDraggingSub(false)
    e.currentTarget.releasePointerCapture(e.pointerId)
    subDragStartRef.current = null
  }

  const revealControls = () => {
    setShowControls(true)
    if (hideControlsTimer.current) {
      clearTimeout(hideControlsTimer.current)
    }
    if (isPlaying) {
      hideControlsTimer.current = setTimeout(() => {
        setShowControls(false)
      }, 2500)
    }
  }

  const handleContainerMouseMove = () => {
    revealControls()
  }

  const handleContainerMouseLeave = () => {
    if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current)
    if (isPlaying) {
      setShowControls(false)
    }
  }

  // 播放状态改变时重置/控制显示逻辑
  useEffect(() => {
    if (!isPlaying) {
      setShowControls(true)
      if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current)
    } else {
      revealControls()
    }
    return () => {
      if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current)
    }
  }, [isPlaying])

  // 监听全屏状态变化
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
    }
  }, [])

  // 监听键盘空格键控制播放/暂停
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.isContentEditable)
      ) {
        return
      }

      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault()
        if (videoRef.current) {
          if (videoRef.current.paused) {
            videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {})
          } else {
            videoRef.current.pause()
            setIsPlaying(false)
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

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
    let isCancelled = false
    let video: HTMLVideoElement | null = null

    const extract = async () => {
      try {
        video = document.createElement('video')
        video.src = videoUrl
        video.crossOrigin = 'anonymous'
        video.muted = true
        video.playsInline = true

        await new Promise((resolve, reject) => {
          if (!video) return resolve(null)
          video.onloadedmetadata = () => {
            if (video && video.videoHeight > 0) {
              setVideoHeight(video.videoHeight)
            }
            resolve(null)
          }
          video.onerror = reject
        })

        if (isCancelled || !video) return

        const count = 16
        const interval = video.duration / count
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const r = video.videoWidth / video.videoHeight
        canvas.height = 45
        canvas.width = Math.round(45 * (r || 16/9))

        const thumbs: string[] = []
        for (let i = 0; i < count; i++) {
          if (isCancelled) break
          video.currentTime = i * interval
          await new Promise(r => { if (video) video.onseeked = r })
          if (isCancelled) break
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          thumbs.push(canvas.toDataURL('image/jpeg', 0.4))
        }
        if (!isCancelled) {
          setThumbnails(thumbs)
        }
      } catch (e) {
        console.error('Failed to extract thumbs', e)
      } finally {
        if (video) {
          video.pause()
          video.removeAttribute('src')
          video.load()
          video = null
        }
      }
    }
    extract()

    return () => {
      isCancelled = true
      if (video) {
        video.pause()
        video.removeAttribute('src')
        video.load()
        video = null
      }
    }
  }, [videoUrl])

  // 节流平滑同步视频时间 (降频至约 15fps 避免每秒60-120次全量 React 重绘引发顿卡)
  useEffect(() => {
    let animationFrameId: number
    let lastTime = 0
    const updateTime = () => {
      if (videoRef.current && !videoRef.current.paused && !isDraggingRef.current) {
        const cur = videoRef.current.currentTime
        if (Math.abs(cur - lastTime) >= 0.07) {
          setCurrentTime(cur)
          lastTime = cur
        }
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

  // 同步视频时长与当前时间及真实画质
  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      if (videoRef.current.duration > 0) {
        setDuration(videoRef.current.duration)
      }
      if (videoRef.current.videoHeight > 0) {
        setVideoHeight(videoRef.current.videoHeight)
      }
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

  // 动态导出画质选项
  const exportOptions = getExportQualityOptions(videoHeight)
  const activeOption = exportOptions.find((opt) => opt.id === selectedQualityId) || exportOptions[0]

  return (
    <div className="flex-grow flex flex-col p-4 sm:p-6 max-w-[1680px] mx-auto w-full select-none">
      {/* 左右分栏布局：左侧原版视频主卡片 + 右侧独立白底字幕与 AI 学习卡片 (中间隔开 gap-5) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 xl:gap-6 items-start">

        {/* 左侧 8 列：原版视频工作台卡片 (包含 Header + 视频播放视口 + 多轨时间轴，完美保持原格式) */}
        <div className="lg:col-span-8 xl:col-span-8 flex flex-col bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 shadow-xl dark:shadow-2xl overflow-hidden">
          
          {/* 顶部集成式工具栏 */}
          <div className="bg-slate-50/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800 px-5 py-3.5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-500/20 text-xs font-semibold shadow-2xs">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                任务已完成
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

            {/* 自动生成的视频标题 */}
            {taskStatus?.video_title && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-purple-50/90 dark:bg-purple-500/10 border border-purple-200/80 dark:border-purple-500/20 text-purple-700 dark:text-purple-300 font-semibold text-xs max-w-sm lg:max-w-md shadow-2xs">
                <Film className="w-4 h-4 text-purple-500 shrink-0" />
                <span className="truncate" title={taskStatus.video_title}>
                  {taskStatus.video_title}
                </span>
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={onReset}
                className="bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl text-xs gap-2 cursor-pointer shadow-2xs"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                新建任务
              </Button>

              {/* 导出视频按钮 */}
              <DropdownMenu>
                <DropdownMenuTrigger className="bg-purple-600 hover:bg-purple-700 text-white font-semibold text-xs px-4 py-2 rounded-xl flex items-center gap-2 transition-all cursor-pointer border-none shadow-sm outline-none">
                  <Download className="w-3.5 h-3.5" />
                  导出视频
                  <span className="text-[10px] bg-white/20 px-1.5 py-0.5 rounded font-normal flex items-center gap-0.5">
                    {activeOption.shortLabel} <ChevronDown className="w-3 h-3" />
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200 w-52 rounded-xl p-1.5 shadow-xl">
                  {exportOptions.map((opt) => {
                    const isSelected = opt.id === activeOption.id
                    return (
                      <DropdownMenuItem
                        key={opt.id}
                        onClick={() => {
                          setSelectedQualityId(opt.id)
                          const exportFilename = getExportFilename(taskStatus?.filename, taskStatus?.target_lang)
                          const a = document.createElement('a')
                          a.href = exportUrl
                          a.download = exportFilename
                          a.click()
                        }}
                        className={`flex justify-between items-center rounded-lg text-xs cursor-pointer px-3 py-2 ${
                          isSelected
                            ? 'bg-purple-50 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300 font-medium'
                            : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        <span>{opt.label}</span>
                        {isSelected && <Check className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />}
                      </DropdownMenuItem>
                    )
                  })}
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

          {/* 巨幕视频播放器视口 (保持原本独占全宽的巨幕格式，绝不动摇) */}
          <div
            ref={videoContainerRef}
            onMouseMove={handleContainerMouseMove}
            onMouseLeave={handleContainerMouseLeave}
            className={`relative group bg-[#0F172A] dark:bg-[#090D16] flex flex-col items-center justify-center border-b border-slate-200/80 dark:border-slate-800 ${
              isFullscreen
                ? 'fixed inset-0 z-50 w-screen h-screen min-h-screen border-none rounded-none'
                : 'min-h-[380px] lg:min-h-[460px]'
            } ${!showControls && isPlaying ? 'cursor-none' : ''}`}
          >
            {/* 顶部模式标签 */}
            <div
              className={`absolute top-4 left-4 z-20 bg-black/40 backdrop-blur-md px-3.5 py-1.5 rounded-full text-xs font-medium text-white/90 border border-white/10 flex items-center gap-2 shadow-lg transition-opacity duration-300 ${
                showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            >
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
              className={`w-full object-contain cursor-pointer transition-all ${
                isFullscreen ? 'h-full max-h-screen' : 'h-full max-h-[480px]'
              }`}
              playsInline
            />

            {/* 悬浮字幕显示区 */}
            {activeSubtitle && (
              <div
                onPointerDown={handleSubPointerDown}
                onPointerMove={handleSubPointerMove}
                onPointerUp={handleSubPointerUp}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  setSubtitlePos(null)
                }}
                style={
                  subtitlePos
                    ? {
                        transform: `translate3d(calc(-50% + ${subtitlePos.x}px), ${subtitlePos.y}px, 0)`,
                        willChange: isDraggingSub ? 'transform' : 'auto',
                      }
                    : undefined
                }
                className={`absolute left-1/2 -translate-x-1/2 px-6 py-2.5 rounded-2xl bg-black/75 backdrop-blur-md border border-white/15 shadow-2xl text-center max-w-[92%] w-max z-30 cursor-grab active:cursor-grabbing select-none ${
                  isDraggingSub
                    ? 'transition-none scale-[1.01] shadow-[0_0_24px_rgba(168,85,247,0.5)] border-purple-400/80'
                    : 'transition-[bottom,opacity,transform] duration-200 hover:border-purple-400/40'
                } ${showControls ? 'bottom-20' : 'bottom-10'}`}
                title={subtitlePos ? '拖动自定义字幕位置（双击重置为自适应）' : '默认自适应位置（按住可拖动自定义）'}
              >
                <p className="text-base sm:text-xl lg:text-2xl font-bold text-white tracking-wide whitespace-nowrap overflow-hidden text-ellipsis drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)] pointer-events-none">
                  {activeSubtitle}
                </p>
                {subtitlePos && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setSubtitlePos(null)
                    }}
                    className="absolute -top-2.5 -right-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-full p-0.5 text-[10px] font-bold shadow-md border border-white/20 cursor-pointer flex items-center justify-center w-5 h-5 transition-transform hover:scale-110"
                    title="恢复默认自适应位置"
                  >
                    ✕
                  </button>
                )}
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
            <div
              className={`absolute bottom-4 left-4 right-4 h-14 bg-slate-900/80 dark:bg-slate-900/80 backdrop-blur-xl rounded-2xl border border-white/15 flex items-center px-4 sm:px-6 gap-4 text-white/90 shadow-2xl z-20 transition-opacity duration-300 ${
                showControls ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
              }`}
            >
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
                        {audioWaveformA1}
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
                        {audioWaveformA2}
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* 右侧 4 列：独立白底字幕与 AI 学习卡片 (与视频主卡片隔开 gap-5，背景为白色) */}
        {!isFullscreen && (
          <div className="lg:col-span-4 xl:col-span-4 flex flex-col bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 shadow-xl dark:shadow-2xl overflow-hidden h-[760px] lg:h-[790px] select-text">

            {/* 白底面板顶栏：Tab 切换与字幕导出 */}
            <div className="bg-slate-50/90 dark:bg-slate-800/60 border-b border-slate-200/80 dark:border-slate-800 px-4 py-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-1.5 bg-slate-200/60 dark:bg-slate-800 p-1 rounded-2xl border border-slate-300/50 dark:border-slate-700/60">
                <button
                  onClick={() => setRightPanelTab('subtitles')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                    rightPanelTab === 'subtitles'
                      ? 'bg-purple-600 text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <ListFilter className="w-3.5 h-3.5" />
                  字幕列表
                  <span className="text-[10px] bg-white/20 px-1.5 py-0.2 rounded-full font-mono">
                    {subtitles.length}
                  </span>
                </button>

                <button
                  onClick={() => {
                    setRightPanelTab('ai')
                    if (!aiAnalysisResult && !aiLoading) {
                      handleRunAIAnalysis('summary')
                    }
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                    rightPanelTab === 'ai'
                      ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <Wand2 className="w-3.5 h-3.5 text-amber-300 animate-pulse" />
                  AI 分析总结
                </button>
              </div>

              {/* 导出字幕下拉 */}
              <DropdownMenu>
                <DropdownMenuTrigger className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs px-3 py-1.5 rounded-xl flex items-center gap-1.5 cursor-pointer transition-colors outline-none shadow-2xs">
                  <FileDown className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                  导出字幕
                  <ChevronDown className="w-3 h-3 text-slate-400" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200 w-52 rounded-xl p-1.5 shadow-xl z-50">
                  <DropdownMenuItem onClick={() => handleExportSubtitles('srt')} className="hover:bg-slate-100 dark:hover:bg-slate-800 text-xs cursor-pointer px-3 py-2 flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> 导出 SRT 格式 (.srt)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExportSubtitles('vtt')} className="hover:bg-slate-100 dark:hover:bg-slate-800 text-xs cursor-pointer px-3 py-2 flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> 导出 WebVTT 格式 (.vtt)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExportSubtitles('txt')} className="hover:bg-slate-100 dark:hover:bg-slate-800 text-xs cursor-pointer px-3 py-2 flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" /> 导出 TXT 纯文本 (.txt)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExportSubtitles('json')} className="hover:bg-slate-100 dark:hover:bg-slate-800 text-xs cursor-pointer px-3 py-2 flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" /> 导出 JSON 格式 (.json)
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="bg-slate-100 dark:bg-slate-800" />
                  <DropdownMenuItem onClick={handleCopyAllSubtitles} className="hover:bg-slate-100 dark:hover:bg-slate-800 text-xs cursor-pointer px-3 py-2 flex items-center gap-2 text-purple-700 dark:text-purple-300 font-medium">
                    {copiedSubtitles ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedSubtitles ? '已复制全量字幕' : '一键复制全量字幕'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* TAB 1: 白底字幕列表 */}
            {rightPanelTab === 'subtitles' && (
              <div className="flex-1 flex flex-col min-h-0 bg-white dark:bg-slate-900">
                {/* 工具搜索与模式切换栏 */}
                <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2 shrink-0 bg-slate-50/50 dark:bg-slate-900/60">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-purple-500/70" />
                    <input
                      type="text"
                      placeholder="搜索字幕关键词..."
                      value={subtitleFilter}
                      onChange={(e) => setSubtitleFilter(e.target.value)}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 rounded-xl text-xs pl-8 pr-2.5 py-1.5 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:border-purple-500 shadow-2xs"
                    />
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setSubtitleDisplayMode(m => m === 'dual' ? 'target' : m === 'target' ? 'source' : 'dual')}
                      className="px-2.5 py-1.5 text-[11px] font-semibold bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-xl cursor-pointer transition-colors shadow-2xs flex items-center gap-1.5"
                      title="切换显示语言模式"
                    >
                      <Languages className="w-3.5 h-3.5 text-indigo-500" />
                      {subtitleDisplayMode === 'dual' ? '双语' : subtitleDisplayMode === 'target' ? '译文' : '原文'}
                    </button>

                    <button
                      onClick={() => setAutoScrollSubtitles(prev => !prev)}
                      className={`px-2.5 py-1.5 text-[11px] font-semibold border rounded-xl cursor-pointer transition-colors flex items-center gap-1.5 shadow-2xs ${
                        autoScrollSubtitles
                          ? 'bg-purple-50 dark:bg-purple-950/60 border-purple-300 dark:border-purple-600/60 text-purple-700 dark:text-purple-300'
                          : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500'
                      }`}
                      title={autoScrollSubtitles ? '已开启实时进度滑动跟随' : '已暂停自动滑动'}
                    >
                      <Compass className={`w-3.5 h-3.5 ${autoScrollSubtitles ? 'animate-spin text-purple-600 dark:text-purple-400' : 'text-slate-400'}`} />
                      跟随
                    </button>
                  </div>
                </div>

                {/* 动态同步虚拟化滚动白底字幕列表 */}
                <div ref={subListRef} className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                  {filteredSubtitles.length > 0 ? (
                    <div
                      style={{
                        height: `${rowVirtualizer.getTotalSize()}px`,
                        width: '100%',
                        position: 'relative',
                      }}
                    >
                      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                        const seg = filteredSubtitles[virtualRow.index]
                        return (
                          <div
                            key={seg.index}
                            data-index={virtualRow.index}
                            ref={rowVirtualizer.measureElement}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              transform: `translateY(${virtualRow.start}px)`,
                              paddingBottom: '10px',
                            }}
                          >
                            <SubtitleItemCard
                              seg={seg}
                              isActive={activeSubIndex === seg.index}
                              subtitleDisplayMode={subtitleDisplayMode}
                              onSeek={handleSeek}
                            />
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-slate-400 text-xs py-10 space-y-2">
                      <Type className="w-8 h-8 stroke-1 text-slate-300 dark:text-slate-600" />
                      <p>暂无可用字幕数据</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 2: 白底 AI 分析总结与学习大纲 / 对话问答 */}
            {rightPanelTab === 'ai' && (
              <div className="flex-1 flex flex-col min-h-0 bg-white dark:bg-slate-900 p-4 space-y-3 overflow-hidden select-text">
                {/* 顶部三态模式切换卡片 */}
                <div className="grid grid-cols-3 gap-2 shrink-0">
                  <button
                    onClick={() => handleRunAIAnalysis('summary')}
                    disabled={aiLoading}
                    className={`p-2.5 rounded-2xl border text-left transition-all cursor-pointer ${
                      aiMode === 'summary'
                        ? 'bg-purple-50 dark:bg-purple-950/80 border-purple-500 text-purple-900 dark:text-purple-200 shadow-2xs font-medium'
                        : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700/60 text-slate-600 dark:text-slate-400 hover:border-slate-300 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold mb-0.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                      核心摘要
                    </div>
                    <p className="text-[10px] opacity-75 line-clamp-1">视频要点与高维总结</p>
                  </button>

                  <button
                    onClick={() => handleRunAIAnalysis('study_notes')}
                    disabled={aiLoading}
                    className={`p-2.5 rounded-2xl border text-left transition-all cursor-pointer ${
                      aiMode === 'study_notes'
                        ? 'bg-indigo-50 dark:bg-indigo-950/80 border-indigo-500 text-indigo-900 dark:text-indigo-200 shadow-2xs font-medium'
                        : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700/60 text-slate-600 dark:text-slate-400 hover:border-slate-300 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold mb-0.5">
                      <BookMarked className="w-3.5 h-3.5 text-blue-500" />
                      学习大纲
                    </div>
                    <p className="text-[10px] opacity-75 line-clamp-1">结构化知识与大纲</p>
                  </button>

                  <button
                    onClick={() => setAiMode('qa')}
                    className={`p-2.5 rounded-2xl border text-left transition-all cursor-pointer ${
                      aiMode === 'qa'
                        ? 'bg-purple-50 dark:bg-purple-950/80 border-purple-500 text-purple-900 dark:text-purple-200 shadow-2xs font-medium'
                        : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700/60 text-slate-600 dark:text-slate-400 hover:border-slate-300 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold mb-0.5">
                      <Bot className="w-3.5 h-3.5 text-purple-600" />
                      字幕问答
                    </div>
                    <p className="text-[10px] opacity-75 line-clamp-1">交互式 AI 提问对话</p>
                  </button>
                </div>

                {/* 模式 1 & 2: 核心摘要 / 学习大纲 Markdown 文档渲染 */}
                {aiMode !== 'qa' && (
                  <div className="flex-1 flex flex-col min-h-0 bg-slate-50/70 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/60 rounded-2xl p-4 overflow-hidden relative">
                    <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700/80 pb-2.5 mb-3 shrink-0">
                      <span className="text-xs font-bold text-purple-800 dark:text-purple-300 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                        {aiMode === 'summary' ? '视频核心摘要报告' : '结构化学习大纲'}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleRunAIAnalysis(aiMode)}
                          disabled={aiLoading}
                          className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 text-[11px] flex items-center gap-1 cursor-pointer bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2.5 py-1 rounded-lg shadow-2xs transition-colors"
                        >
                          <RefreshCw className={`w-3 h-3 ${aiLoading ? 'animate-spin text-purple-600' : ''}`} />
                          重新生成
                        </button>
                        {aiAnalysisResult && (
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(aiAnalysisResult)
                              setCopiedAi(true)
                              setTimeout(() => setCopiedAi(false), 2000)
                            }}
                            className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 text-[11px] flex items-center gap-1 cursor-pointer bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2.5 py-1 rounded-lg shadow-2xs transition-colors"
                          >
                            {copiedAi ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                            {copiedAi ? '已复制' : '复制报告'}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar">
                      {aiLoading ? (
                        <div className="h-full min-h-[200px] flex flex-col items-center justify-center space-y-3 text-purple-600 dark:text-purple-400 py-10">
                          <RefreshCw className="w-8 h-8 animate-spin text-purple-600 dark:text-purple-400" />
                          <p className="text-xs text-slate-700 dark:text-slate-200 animate-pulse font-medium">AI 正在深度解析全量字幕，提炼总结中...</p>
                        </div>
                      ) : aiAnalysisResult ? (
                        <MarkdownRenderer content={aiAnalysisResult} />
                      ) : (
                        <div className="h-full flex flex-col items-center justify-center text-slate-400 text-xs py-10 space-y-2 text-center">
                          <Sparkles className="w-8 h-8 stroke-1 text-purple-500 animate-bounce" />
                          <p className="text-slate-600 dark:text-slate-300 font-medium">点击上方按钮，交由 AI 一键提炼视频摘要与学习大纲</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 模式 3: 字幕问答 (交互式 AI 对话流 Chat Thread) */}
                {aiMode === 'qa' && (
                  <div className="flex-1 flex flex-col min-h-0 bg-slate-50/50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700/80 rounded-2xl overflow-hidden">
                    {/* 对话栏顶栏 Header */}
                    <div className="bg-white dark:bg-slate-800/90 border-b border-slate-200 dark:border-slate-700 px-3.5 py-2.5 flex items-center justify-between shrink-0 shadow-2xs">
                      <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                        <Bot className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                        AI 智能对话助教
                      </span>
                      <button
                        onClick={handleClearChatHistory}
                        className="text-slate-400 hover:text-red-500 text-[11px] flex items-center gap-1 cursor-pointer transition-colors px-2 py-0.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700"
                        title="清空历史对话"
                      >
                        <Trash2 className="w-3 h-3" />
                        清空对话
                      </button>
                    </div>

                    {/* 消息滚动列表 */}
                    <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5 custom-scrollbar">
                      {chatMessages.map((msg) => (
                        <div key={msg.id} className="space-y-1">
                          {msg.role === 'user' ? (
                            /* 用户气泡 (右侧) */
                            <div className="flex flex-col items-end">
                              <div className="bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-2xl rounded-tr-xs px-4 py-2.5 shadow-2xs max-w-[88%] text-xs leading-relaxed font-medium">
                                {msg.content}
                              </div>
                              <span className="text-[10px] text-slate-400 font-mono mt-1 px-1">
                                {msg.timestamp}
                              </span>
                            </div>
                          ) : (
                            /* AI 助气体 (左侧) */
                            <div className="flex items-start gap-2.5 max-w-[95%]">
                              <div className="w-7 h-7 rounded-xl bg-purple-100 dark:bg-purple-900/60 border border-purple-200 dark:border-purple-700 flex items-center justify-center shrink-0 mt-0.5 shadow-2xs">
                                <Bot className="w-4 h-4 text-purple-600 dark:text-purple-300" />
                              </div>
                              <div className="flex-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 rounded-2xl rounded-tl-xs p-3.5 shadow-2xs space-y-2">
                                <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-700/60 pb-1.5 mb-1">
                                  <span className="text-[11px] font-bold text-purple-700 dark:text-purple-300">
                                    AI 视频助教
                                  </span>
                                  <button
                                    onClick={() => navigator.clipboard.writeText(msg.content)}
                                    className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 text-[10px] flex items-center gap-1 cursor-pointer"
                                  >
                                    <Copy className="w-3 h-3" />
                                    复制
                                  </button>
                                </div>

                                <MarkdownRenderer content={msg.content} />

                                <div className="text-[10px] text-slate-400 font-mono pt-1 text-right">
                                  {msg.timestamp}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}

                      {/* AI 正在思考 Loading 气泡 */}
                      {isSendingChat && (
                        <div className="flex items-start gap-2.5">
                          <div className="w-7 h-7 rounded-xl bg-purple-100 dark:bg-purple-900/60 border border-purple-200 dark:border-purple-700 flex items-center justify-center shrink-0 animate-pulse">
                            <Bot className="w-4 h-4 text-purple-600 dark:text-purple-300" />
                          </div>
                          <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl rounded-tl-xs p-3 shadow-2xs flex items-center gap-2 text-xs text-purple-600 dark:text-purple-300 font-medium">
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>AI 正在分析字幕并思考回复...</span>
                          </div>
                        </div>
                      )}

                      <div ref={chatBottomRef} />
                    </div>

                    {/* 底部交互式输入栏与快捷 Chip */}
                    <div className="bg-white dark:bg-slate-800/90 border-t border-slate-200 dark:border-slate-700 p-2.5 space-y-2 shrink-0">
                      {/* 快捷问答 Chip */}
                      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
                        <button
                          onClick={() => handleSendChatMessage('用三句话概括这个视频最核心的内容')}
                          disabled={isSendingChat}
                          className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-700/60 hover:bg-purple-50 dark:hover:bg-purple-950/60 border border-slate-200 dark:border-slate-600 text-[10px] text-slate-700 dark:text-slate-300 whitespace-nowrap cursor-pointer transition-colors flex items-center gap-1 shadow-2xs"
                        >
                          <Lightbulb className="w-3 h-3 text-amber-500" />
                          三句话概括
                        </button>
                        <button
                          onClick={() => handleSendChatMessage('提取视频中的 3 个核心学习要点')}
                          disabled={isSendingChat}
                          className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-700/60 hover:bg-purple-50 dark:hover:bg-purple-950/60 border border-slate-200 dark:border-slate-600 text-[10px] text-slate-700 dark:text-slate-300 whitespace-nowrap cursor-pointer transition-colors flex items-center gap-1 shadow-2xs"
                        >
                          <BookOpen className="w-3 h-3 text-blue-500" />
                          3个核心要点
                        </button>
                        <button
                          onClick={() => handleSendChatMessage('生成 3 个复习思考题与答案')}
                          disabled={isSendingChat}
                          className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-700/60 hover:bg-purple-50 dark:hover:bg-purple-950/60 border border-slate-200 dark:border-slate-600 text-[10px] text-slate-700 dark:text-slate-300 whitespace-nowrap cursor-pointer transition-colors flex items-center gap-1 shadow-2xs"
                        >
                          <HelpCircle className="w-3 h-3 text-purple-500" />
                          复习思考题
                        </button>
                      </div>

                      {/* 输入框行 */}
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          placeholder="输入问题向 AI 提问 (按 Enter 发送)..."
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              handleSendChatMessage()
                            }
                          }}
                          className="flex-1 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:border-purple-500 shadow-2xs"
                        />
                        <Button
                          onClick={() => handleSendChatMessage()}
                          disabled={isSendingChat || !chatInput.trim()}
                          className="bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs px-3.5 py-2 h-auto cursor-pointer gap-1.5 shadow-2xs"
                        >
                          <Send className="w-3.5 h-3.5" />
                          发送
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

